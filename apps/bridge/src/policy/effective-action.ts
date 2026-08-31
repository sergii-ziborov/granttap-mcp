import { hostname } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
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

export async function evaluateEffectiveAction(
  input: EffectiveActionInput,
  options: EffectiveActionOptions = {},
): Promise<EffectiveActionDecision> {
  if (input.legacyDenyReason) return legacyDeny(input.legacyDenyReason);
  const env = options.env ?? process.env;
  if (!projectPolicyFeatureEnabled(env)) return FALLBACK;
  const now = options.now ?? Date.now;
  const deadline = now() + DEFAULT_ENGINE_POLICY_TIMEOUT_MS;
  const endpointId = options.endpointId ?? hostname();
  const ownedClient = options.client == null;
  const client = options.client ?? new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  try {
    const projectId = options.projectId
      ?? meshProjectId(input, endpointId)
      ?? await resolveProject(client, input.cwd, endpointId, deadline, now);
    if (!projectId) return FALLBACK;
    const result = await client.request({
      operation: "policy.evaluate_action",
      input: {
        provider: "inherit",
        account: "inherit",
        project: "inherit",
        task: "inherit",
        project_id: projectId,
        endpoint_id: endpointId,
        capability: input.capability ?? capabilityFingerprint({
          provider: input.provider, cwd: input.cwd,
          toolName: input.toolName, toolInput: input.toolInput,
        }),
        impact_available: false,
      },
    }, { timeoutMs: remaining(deadline, now) });
    if (result.operation !== "policy.evaluated") return FALLBACK;
    return { ...result.decision, projectId, engineEvaluated: true };
  } catch {
    return FALLBACK;
  } finally {
    if (ownedClient) client.close();
  }
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
