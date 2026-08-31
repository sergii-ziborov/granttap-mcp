import { hostname } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "../../../../packages/core/relay-client";
import type {
  ProjectCapabilityKind,
  ProjectEnforcementStatus,
  ProjectPolicyAck,
  ProjectPolicyPayload,
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
};

export function createProjectPolicyRuntime(deps: ProjectPolicyRuntimeDependencies) {
  async function apply(relay: RelayClient, request: ProjectPolicySet): Promise<boolean> {
    try {
      const applied = await deps.client.request({
        operation: "policy.apply",
        input: {
          expected_revision: request.expectedRevision,
          policy: policyToEngine(request.policy),
        },
      }, { timeoutMs: 250 });
      if (applied.operation !== "policy.applied") return false;
      const targets = new Map(deps.providers().map((item) => [item.provider, item]));
      for (const target of [...targets.values()].sort((left, right) =>
        left.provider.localeCompare(right.provider))) {
        const acknowledgement = localAcknowledgement(
          request.projectId, applied.policy.revision, deps.endpointId(), target, deps.now(),
        );
        const accepted = await deps.client.request({
          operation: "policy.ack", input: { acknowledgement },
        }, { timeoutMs: 250 });
        if (accepted.operation !== "policy.acknowledged") return false;
        if (accepted.acknowledgement.project_id !== request.projectId
          || accepted.acknowledgement.policy_revision !== applied.policy.revision
          || accepted.acknowledgement.endpoint_id !== acknowledgement.endpoint_id
          || accepted.acknowledgement.provider !== target.provider) return false;
        const payload: ProjectPolicyAck = {
          type: "project.policy.ack", sessionId: request.projectId,
          projectId: request.projectId,
          acknowledgement: acknowledgementFromEngine(accepted.acknowledgement),
        };
        await deps.send(relay, payload);
      }
      const reported = await deps.client.request({
        operation: "policy.coverage", input: { project_id: request.projectId },
      }, { timeoutMs: 250 });
      if (reported.operation !== "policy.coverage") return false;
      return sendStatus(relay, applied.policy, reported.coverage);
    } catch {
      return false;
    }
  }

  async function publishOne(relay: RelayClient, projectId: string): Promise<boolean> {
    try {
      const [found, reported] = await Promise.all([
        deps.client.request({
          operation: "policy.get", input: { project_id: projectId },
        }, { timeoutMs: 250 }),
        deps.client.request({
          operation: "policy.coverage", input: { project_id: projectId },
        }, { timeoutMs: 250 }),
      ]);
      if (found.operation !== "policy.found" || found.policy.revision === 0
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
