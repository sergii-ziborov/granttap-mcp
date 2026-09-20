import { isAbsolute, join, normalize } from "node:path";
import { inspectRepository } from "../mesh/catalog";
import { computerId } from "../mesh/computer-identity";
import { localMeshStore } from "../mesh/local";
import { evaluateWriteRestrictions } from "../mesh/restrictions";
import { configDir } from "../config/paths";
import { EngineClient } from "../engine/engine-client";
import type {
  CapabilityFingerprint,
  EnginePolicyDecision,
  PolicyEffect,
  PolicySource,
} from "../engine/engine-policy-types";
import { DEFAULT_ENGINE_POLICY_TIMEOUT_MS } from "../engine/engine-protocol";
import { engineFeatureEnabled, type EngineClientLike } from "../engine/engine-supervisor";
import { loadStoreState } from "../mesh/store-state";
import { capabilityFingerprint } from "./capability-fingerprint";
import { governedRevision, rememberGovernedProject } from "./governed-projects";

export type EffectiveActionInput = {
  provider: "claude" | "codex" | "cursor" | "grok";
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  capability?: CapabilityFingerprint;
  legacyDenyReason?: string;
};

export type EffectiveActionDecision = EnginePolicyDecision & {
  projectId?: string;
  engineEvaluated: boolean;
  artifactHash?: string;
};

export type EffectiveActionOptions = {
  env?: NodeJS.ProcessEnv;
  client?: EngineClientLike;
  endpointId?: string;
  projectId?: string;
  now?: () => number;
};

const FALLBACK: EffectiveActionDecision = {
  effect: "inherit",
  source: "none",
  reason: "Project policy unavailable; legacy GrantTap behavior applies",
  engineEvaluated: false,
};

export function projectPolicyFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GRANTTAP_PROJECT_POLICY_ENABLED?.trim().toLowerCase();
  return engineFeatureEnabled(env) && (value === "1" || value === "true");
}

export function legacyGrantTapFlowAllowed(decision: EffectiveActionDecision): boolean {
  return decision.effect === "inherit" || decision.effect === "allow";
}

function projectIdFromCheckout(cwd: string | undefined, endpointId: string): string | undefined {
  if (!cwd) return undefined;
  try {
    const repository = inspectRepository(cwd);
    return localMeshStore().projectIdForRepository(repository.canonicalRepositoryId, endpointId);
  } catch {
    return undefined;
  }
}

export async function evaluateEffectiveAction(
  input: EffectiveActionInput,
  options: EffectiveActionOptions = {},
): Promise<EffectiveActionDecision> {
  if (input.legacyDenyReason) return legacyDeny(input.legacyDenyReason);
  const env = options.env ?? process.env;
  const endpointId = options.endpointId ?? computerId(env);
  const restrictionProjectId = options.projectId
    ?? meshProjectId(input, endpointId)
    ?? projectIdFromCheckout(input.cwd, endpointId);
  let restriction: ReturnType<typeof evaluateWriteRestrictions>;
  try {
    restriction = evaluateWriteRestrictions({
      projectId: restrictionProjectId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      cwd: input.cwd,
    });
  } catch {
    restriction = undefined;
  }
  if (restriction) {
    return {
      effect: restriction.effect,
      source: "project",
      reason: restriction.reason,
      projectId: restrictionProjectId,
      engineEvaluated: false,
    };
  }
  if (!projectPolicyFeatureEnabled(env)) return FALLBACK;
  const now = options.now ?? Date.now;
  const deadline = now() + DEFAULT_ENGINE_POLICY_TIMEOUT_MS;
  const ownedClient = options.client == null;
  const client = options.client ?? new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  let projectId: string | undefined;
  try {
    projectId = options.projectId
      ?? meshProjectId(input, endpointId)
      ?? await resolveProject(client, input.cwd, endpointId, deadline, now);
    if (!projectId) return FALLBACK;
    const capability = input.capability ?? capabilityFingerprint({
      provider: input.provider, cwd: input.cwd,
      toolName: input.toolName, toolInput: input.toolInput,
    });
    const result = await client.request({
      operation: "policy.evaluate_action",
      input: {
        provider: "inherit",
        account: "inherit",
        project: "inherit",
        task: "inherit",
        project_id: projectId,
        endpoint_id: endpointId,
        capability,
        impact_available: false,
      },
    }, { timeoutMs: remaining(deadline, now) });
    if (result.operation !== "policy.evaluated") return unavailable(projectId);
    if (result.decision.policy_revision != null) {
      rememberGovernedProject(projectId, result.decision.policy_revision, now());
    }
    return { ...result.decision, projectId, engineEvaluated: true,
      artifactHash: capability.script_hash };
  } catch {
    return projectId ? unavailable(projectId) : FALLBACK;
  } finally {
    if (ownedClient) client.close();
  }
}

/**
 * No answer from the engine. A Project this computer has seen governed does
 * not fall open: the action goes to the person, as ASK, until the engine
 * answers again. A Project never seen governed keeps legacy behaviour.
 */
function unavailable(projectId: string): EffectiveActionDecision {
  const revision = governedRevision(projectId);
  if (revision == null) return { ...FALLBACK, projectId };
  return {
    effect: "ask",
    source: "project",
    reason: `Project policy (revision ${revision}) could not be evaluated; GrantTap approval is required`,
    policy_revision: revision,
    projectId,
    engineEvaluated: false,
  };
}

function meshProjectId(input: EffectiveActionInput, endpointId: string): string | undefined {
  if (!input.sessionId) return undefined;
  const state = loadStoreState(join(configDir(), "project-mesh.json"));
  const execution = state.executions.find((item) =>
    item.provider === input.provider
    && item.sessionId === input.sessionId
    && item.computerId === endpointId);
  if (!execution) return undefined;
  return state.tasks.find((item) => item.taskId === execution.taskId)?.projectId;
}

async function resolveProject(
  client: EngineClientLike,
  cwd: string | undefined,
  endpointId: string,
  deadline: number,
  now: () => number,
): Promise<string | undefined> {
  const localRoot = boundedRoot(cwd);
  if (!localRoot) return undefined;
  const result = await client.request({
    operation: "project.resolve",
    input: { endpoint_id: endpointId, local_root: localRoot },
  }, { timeoutMs: remaining(deadline, now) });
  return result.operation === "project.resolved" && !result.resolution.compatibility_mode
    ? result.resolution.project_id
    : undefined;
}

function boundedRoot(value: string | undefined): string | undefined {
  if (!value || value.length > 4_096 || !isAbsolute(value)) return undefined;
  const root = normalize(value);
  return root.includes("\0") ? undefined : root;
}

function remaining(deadline: number, now: () => number): number {
  return Math.max(1, deadline - now());
}

function legacyDeny(reason: string): EffectiveActionDecision {
  return {
    effect: "deny" satisfies PolicyEffect,
    source: "task" satisfies PolicySource,
    reason,
    engineEvaluated: false,
  };
}
