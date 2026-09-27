import type { RelayClient } from "../../../../packages/core/relay-client";
import type {
  ProjectPolicy,
  ProjectPolicyAck,
  ProjectPolicyRejected,
  ProjectPolicySet,
  ProjectPolicyStatus,
} from "../../../../packages/protocol/schema";
import { rememberGovernedProject } from "../policy/governed-projects";
import { loadExecutionPolicy, rememberExecutionPolicy } from "../mesh/runtime/execution-policy";
import { localMeshStore } from "../mesh/local-remote/local";
import {
  assertProjectEnvironmentKeys,
  loadEnvironment,
  removeManagedRepoEnv,
  rememberEnvironment,
  redactEnvironment,
  writeRepoEnv,
} from "../mesh/context/env";
import { loadRestrictions, rememberRestrictions, writeRepoRestrictions } from "../mesh/restrictions";
import type {
  EnginePolicyCoverage,
  EngineProjectPolicy,
} from "../engine/protocol/engine-policy-protocol";
import {
  acknowledgementFromEngine,
  coverageFromEngine,
  policyFromEngine,
  policyToEngine,
} from "./mapping";
import {
  enforcementCoverageFor,
  rejectionReason,
  type ProjectPolicyRuntimeDependencies,
} from "./types";

const CAPABILITIES = [
  "agent", "mcp", "skill", "shell", "script", "file_write", "deploy", "network",
] as const;

type LocalRepository = { repositoryId: string; root: string };

function projectRepositoryRoots(projectId: string, endpointId: string): LocalRepository[] {
  try {
    const snapshot = localMeshStore().snapshot(projectId);
    const roots = new Map<string, LocalRepository>();
    for (const item of snapshot?.bindings ?? []) {
      if (item.endpointId === endpointId && item.available && item.localPathHint) {
        roots.set(item.localPathHint, { repositoryId: item.repositoryId, root: item.localPathHint });
      }
    }
    return [...roots.values()];
  } catch {
    return [];
  }
}

export function persistMeshPolicyExtras(projectId: string, policy: ProjectPolicy, endpointId: string): void {
  assertProjectEnvironmentKeys(policy.environment);
  const roots = projectRepositoryRoots(projectId, endpointId);
  const restrictions = policy.restrictions;
  let restrictionRoot = roots[0]?.root;
  if (restrictions?.scope === "sync_from_repo") {
    const sources = restrictions.repositoryId
      ? roots.filter((item) => item.repositoryId === restrictions.repositoryId)
      : roots;
    if (sources.length !== 1) {
      throw new Error("sync_from_repo needs one exact local repository binding");
    }
    restrictionRoot = sources[0]?.root;
  }
  rememberRestrictions(projectId, restrictions, restrictionRoot);
  if (restrictions?.scope === "project_and_repo") {
    for (const item of roots.slice(1)) writeRepoRestrictions(item.root, restrictions);
  }
  const stored = rememberEnvironment(projectId, policy.environment, roots[0]?.root);
  for (const item of roots.slice(1)) {
    if (stored?.shareNonSecretsWithRepo) writeRepoEnv(item.root, stored.variables);
    else removeManagedRepoEnv(item.root);
  }
}

function withLocalExecution(policy: ProjectPolicy): ProjectPolicy {
  const execution = loadExecutionPolicy(policy.projectId);
  const restrictions = loadRestrictions(policy.projectId);
  const environment = redactEnvironment(loadEnvironment(policy.projectId));
  return {
    ...policy,
    ...(execution ? {
      execution: {
        mode: execution.mode,
        targetEndpointId: execution.targetEndpointId,
        defaultProvider: execution.defaultProvider,
        defaultModel: execution.defaultModel,
        revision: execution.revision,
        hostGrantId: execution.hostGrantId,
        hostGrantStatus: execution.hostGrantStatus,
        offlineBehavior: execution.offlineBehavior,
      },
    } : {}),
    ...(restrictions ? { restrictions } : {}),
    ...(environment ? { environment } : {}),
  };
}

async function sendStatus(
  deps: ProjectPolicyRuntimeDependencies,
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
      policy: withLocalExecution(policyFromEngine(policy)),
      coverage: coverageFromEngine(coverage),
      generatedAt: deps.now(),
    };
    await deps.send(relay, payload);
    return true;
  } catch {
    return false;
  }
}

export async function publishOne(
  deps: ProjectPolicyRuntimeDependencies,
  relay: RelayClient,
  projectId: string,
): Promise<boolean> {
  try {
    const [found, reported] = await Promise.all([
      deps.client.request({
        operation: "policy.get", input: { project_id: projectId },
      }, { timeoutMs: 2_000 }),
      deps.client.request({
        operation: "policy.coverage", input: { project_id: projectId },
      }, { timeoutMs: 2_000 }),
    ]);
    if (found.operation !== "policy.found"
      || reported.operation !== "policy.coverage") return false;
    rememberGovernedProject(projectId, found.policy.revision, deps.now());
    return sendStatus(deps, relay, found.policy, reported.coverage);
  } catch {
    return false;
  }
}

async function rejectPolicy(
  deps: ProjectPolicyRuntimeDependencies,
  relay: RelayClient,
  request: ProjectPolicySet,
  error: unknown,
): Promise<void> {
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
    ...(request.requestId ? { requestId: request.requestId } : {}),
    generatedAt: deps.now(),
  };
  try {
    await deps.send(relay, payload);
    if (currentRevision != null) await publishOne(deps, relay, request.projectId);
  } catch {
    // Nothing more can be said over a relay that is not taking messages.
  }
}

export async function applyPolicy(
  deps: ProjectPolicyRuntimeDependencies,
  relay: RelayClient,
  request: ProjectPolicySet,
): Promise<boolean> {
  rememberGovernedProject(request.projectId, request.policy.revision, deps.now());
  try {
    assertProjectEnvironmentKeys(request.policy.environment);
    const applied = await deps.client.request({
      operation: "policy.apply",
      input: {
        expected_revision: request.expectedRevision,
        policy: policyToEngine(request.policy),
      },
    }, { timeoutMs: 2_000 });
    if (applied.operation !== "policy.applied") throw new Error(`engine answered ${applied.operation}`);
    rememberGovernedProject(request.projectId, applied.policy.revision, deps.now());
    rememberExecutionPolicy(
      request.projectId,
      request.policy.execution
        ? { ...request.policy.execution, revision: applied.policy.revision }
        : undefined,
      deps.endpointId(),
    );
    persistMeshPolicyExtras(request.projectId, {
      ...request.policy,
      revision: applied.policy.revision,
      restrictions: request.policy.restrictions
        ? { ...request.policy.restrictions, revision: applied.policy.revision }
        : undefined,
      environment: request.policy.environment
        ? { ...request.policy.environment, revision: applied.policy.revision }
        : undefined,
    }, deps.endpointId());
    const targets = new Map(deps.providers().map((item) => [item.provider, item]));
    for (const target of [...targets.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider))) {
      const acknowledgement = {
        project_id: request.projectId,
        policy_revision: applied.policy.revision,
        endpoint_id: deps.endpointId(),
        provider: target.provider,
        capabilities: CAPABILITIES.map((kind) => ({
          kind, status: enforcementCoverageFor(target.provider, kind, target.hookConfigured),
        })),
        observed_at: deps.now(),
      };
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
    const sent = await sendStatus(deps, relay, applied.policy, reported.coverage);
    if (!sent) deps.log?.(`applied revision ${applied.policy.revision} of ${request.projectId} but could not report it`);
    return sent;
  } catch (error) {
    await rejectPolicy(deps, relay, request, error);
    return false;
  }
}
