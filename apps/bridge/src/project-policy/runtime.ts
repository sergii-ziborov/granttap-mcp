import { hostname } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "../../../../packages/core/relay-client";
import type {
  ProjectCapabilityKind,
  ProjectEnforcementStatus,
  ProjectPolicyAck,
  ProjectPolicyPayload,
  ProjectPolicyRejected,
  ProjectPolicyRejectionReason,
  ProjectPolicySet,
  ProjectPolicyStatus,
} from "../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../config/runtime";
import { configDir } from "../config/paths";
import { EngineClient } from "../engine/engine-client";
import type {
  EnginePolicyAcknowledgement,
  EnginePolicyCoverage,
  EngineProjectPolicy,
} from "../engine/engine-policy-protocol";
import { engineFeatureEnabled, type EngineClientLike } from "../engine/engine-supervisor";
import { inspectAgentIntegrations } from "../install";
import { sendProjectPayload } from "../session-keys";
import {
  acknowledgementFromEngine,
  coverageFromEngine,
  policyFromEngine,
  policyToEngine,
} from "./mapping";

const CAPABILITIES: ProjectCapabilityKind[] = [
  "agent", "mcp", "skill", "shell", "script", "file_write", "deploy", "network",
];
type ProviderCoverageTarget = {
  provider: "claude" | "codex" | "cursor" | "grok";
  hookConfigured: boolean;
};

export type ProjectPolicyRuntimeDependencies = {
  client: EngineClientLike;
  endpointId: () => string;
  providers: () => ProviderCoverageTarget[];
  now: () => number;
  send: (relay: RelayClient, payload: ProjectPolicyPayload) => Promise<void>;
  /** A line for the helper log when a policy could not be applied or reported. */
  log?: (line: string) => void;
};

/** What a failed apply was, from what the engine said about it. */
export function rejectionReason(error: unknown): ProjectPolicyRejectionReason {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/revision|conflict|expected/i.test(message)) return "revision_mismatch";
  if (/ECONNREFUSED|ENOENT|EPIPE|socket|timed? ?out|unavailable|not running/i.test(message)) {
    return "engine_unavailable";
  }
  if (/invalid|schema|malformed|scope/i.test(message)) return "invalid_policy";
  return "unknown";
}

export function createProjectPolicyRuntime(deps: ProjectPolicyRuntimeDependencies) {
  async function apply(relay: RelayClient, request: ProjectPolicySet): Promise<boolean> {
    try {
      const applied = await deps.client.request({
        operation: "policy.apply",
        input: {
          expected_revision: request.expectedRevision,
          policy: policyToEngine(request.policy),
        },
      }, { timeoutMs: 2_000 });
      if (applied.operation !== "policy.applied") throw new Error(`engine answered ${applied.operation}`);
      const targets = new Map(deps.providers().map((item) => [item.provider, item]));
      for (const target of [...targets.values()].sort((left, right) =>
        left.provider.localeCompare(right.provider))) {
        const acknowledgement = localAcknowledgement(
          request.projectId, applied.policy.revision, deps.endpointId(), target, deps.now(),
        );
        const accepted = await deps.client.request({
          operation: "policy.ack", input: { acknowledgement },
        }, { timeoutMs: 2_000 });
        if (accepted.operation !== "policy.acknowledged") throw new Error(`engine answered ${accepted.operation}`);
        if (accepted.acknowledgement.project_id !== request.projectId
          || accepted.acknowledgement.policy_revision !== applied.policy.revision
          || accepted.acknowledgement.endpoint_id !== acknowledgement.endpoint_id
          || accepted.acknowledgement.provider !== target.provider) {
          throw new Error("engine acknowledged a different scope");
        }
        const payload: ProjectPolicyAck = {
          type: "project.policy.ack", sessionId: request.projectId,
          projectId: request.projectId,
          acknowledgement: acknowledgementFromEngine(accepted.acknowledgement),
        };
        await deps.send(relay, payload);
      }
      const reported = await deps.client.request({
        operation: "policy.coverage", input: { project_id: request.projectId },
      }, { timeoutMs: 2_000 });
      if (reported.operation !== "policy.coverage") throw new Error(`engine answered ${reported.operation}`);
      const sent = await sendStatus(relay, applied.policy, reported.coverage);
      if (!sent) deps.log?.(`applied revision ${applied.policy.revision} of ${request.projectId} but could not report it`);
      return sent;
    } catch (error) {
      await reject(relay, request, error);
      return false;
    }
  }

  /**
   * A refused edit is answered, not swallowed: the phone learns why, and the
   * policy the computer actually holds follows so the next edit is made on
   * top of it rather than on a revision that no longer exists.
   */
  async function reject(relay: RelayClient, request: ProjectPolicySet, error: unknown): Promise<void> {
    const reason = rejectionReason(error);
    const detail = (error instanceof Error ? error.message : String(error ?? "")).slice(0, 240);
    deps.log?.(`could not apply revision ${request.policy.revision} of ${request.projectId} (${reason}): ${detail}`);
    let currentRevision: number | undefined;
    try {
      const found = await deps.client.request({
        operation: "policy.get", input: { project_id: request.projectId },
      }, { timeoutMs: 2_000 });
      if (found.operation === "policy.found") currentRevision = found.policy.revision;
    } catch {
      // The engine could not say; the phone still learns the edit was refused.
    }
    const payload: ProjectPolicyRejected = {
      type: "project.policy.rejected", sessionId: request.projectId, projectId: request.projectId,
      expectedRevision: request.expectedRevision,
      ...(currentRevision != null ? { currentRevision } : {}),
      reason,
      ...(detail ? { detail } : {}),
      generatedAt: deps.now(),
    };
    try {
      await deps.send(relay, payload);
      if (currentRevision != null) await publishOne(relay, request.projectId);
    } catch {
      // Nothing more can be said over a relay that is not taking messages.
    }
  }

  async function publishOne(relay: RelayClient, projectId: string): Promise<boolean> {
    try {
      const [found, reported] = await Promise.all([
        deps.client.request({
          operation: "policy.get", input: { project_id: projectId },
        }, { timeoutMs: 2_000 }),
        deps.client.request({
          operation: "policy.coverage", input: { project_id: projectId },
        }, { timeoutMs: 2_000 }),
      ]);
      // Revision 0 means this Project has no policy yet. Withholding it left the
      // phone showing "Governance not reported" with no way to author the first
      // one, because the editor only unlocks once a policy has been reported.
      if (found.operation !== "policy.found"
        || reported.operation !== "policy.coverage") return false;
      return sendStatus(relay, found.policy, reported.coverage);
    } catch {
      return false;
    }
  }

  async function sendStatus(
    relay: RelayClient,
    policy: EngineProjectPolicy,
    coverage: EnginePolicyCoverage,
  ): Promise<boolean> {
    try {
      if (coverage.project_id !== policy.project_id
        || coverage.policy_revision !== policy.revision
        || coverage.enforcement !== policy.enforcement) return false;
      const payload: ProjectPolicyStatus = {
        type: "project.policy.status", sessionId: policy.project_id,
        projectId: policy.project_id,
        policy: policyFromEngine(policy),
        coverage: coverageFromEngine(coverage),
        generatedAt: deps.now(),
      };
      await deps.send(relay, payload);
      return true;
    } catch {
      return false;
    }
  }

  async function publish(relay: RelayClient, projectIds: string[]): Promise<void> {
    for (const projectId of [...new Set(projectIds)].sort()) {
      await publishOne(relay, projectId);
    }
  }

  return { apply, publish };
}

export function enforcementCoverageFor(
  provider: "claude" | "codex" | "cursor" | "grok",
  kind: ProjectCapabilityKind,
  hookConfigured = true,
): ProjectEnforcementStatus {
  if (provider === "grok") return kind === "shell" ? "observed" : "unsupported";
  if (kind === "agent") return "unsupported";
  if (!hookConfigured) return "unknown";
  if (provider === "cursor" && (kind === "skill" || kind === "file_write")) {
    return "unsupported";
  }
  return "enforced";
}

function localAcknowledgement(
  projectId: string,
  revision: number,
  endpointId: string,
  target: ProviderCoverageTarget,
  observedAt: number,
): EnginePolicyAcknowledgement {
  return {
    project_id: projectId,
    policy_revision: revision,
    endpoint_id: endpointId,
    provider: target.provider,
    capabilities: CAPABILITIES.map((kind) => ({
      kind, status: enforcementCoverageFor(target.provider, kind, target.hookConfigured),
    })),
    observed_at: observedAt,
  };
}

export function projectPolicyFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.GRANTTAP_PROJECT_POLICY_ENABLED?.trim().toLowerCase();
  return engineFeatureEnabled(env) && (enabled === "1" || enabled === "true");
}

let sharedClient: EngineClient | undefined;

function defaultRuntime() {
  sharedClient ??= new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  return createProjectPolicyRuntime({
    client: sharedClient,
    log: (line) => process.stderr.write(`[monitor] rules: ${line}\n`),
    endpointId: hostname,
    providers: () => {
      const configured = loadRuntimeConfig().providerSettings;
      return inspectAgentIntegrations()
        .filter((item) => item.installed && configured[item.agent])
        .map((item) => ({ provider: item.agent, hookConfigured: item.hookConfigured }));
    },
    now: Date.now,
    send: (relay, payload) => sendProjectPayload(relay, payload, "phone", {
      ttlMs: 24 * 60 * 60_000,
    }),
  });
}

export function handleProjectPolicySet(
  relay: RelayClient,
  request: ProjectPolicySet,
): Promise<boolean> {
  if (!projectPolicyFeatureEnabled()) return Promise.resolve(false);
  return defaultRuntime().apply(relay, request);
}

export function publishProjectPolicyStatuses(
  relay: RelayClient,
  projectIds: string[],
): Promise<void> {
  if (!projectPolicyFeatureEnabled()) return Promise.resolve();
  return defaultRuntime().publish(relay, projectIds);
}
