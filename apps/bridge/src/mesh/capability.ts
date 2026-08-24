/**
 * Opaque per-execution Mesh capabilities.
 *
 * A capability names exactly one live execution: its Project, its Task, its
 * provider and its native session. It is minted only for a call the provider
 * hook already attributed to that session, and it is returned only into that
 * session's own tool result, so one agent can never obtain another's scope.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  MeshEventType,
  type ExecutionSessionLink,
  type MeshSnapshot,
} from "../../../../packages/protocol/schema";
import { configDir } from "../config";
import { isProviderEnabled } from "../config/runtime";
import { localMeshStore } from "./local";

const CAPABILITY_TTL_MS = 12 * 60 * 60_000;
const MAX_CAPABILITIES = 64;

/** Ownership transfer is decided by the runtime after receipt checks, never by a tool call. */
const PUBLISHABLE_EVENT_TYPES = MeshEventType.options.filter((type) =>
  type !== "HANDOFF_ACCEPTED" && type !== "HANDOFF_REJECTED");

const ExecutionCapability = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  provider: z.enum(["claude", "codex", "cursor", "grok"]),
  sessionId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(128),
  taskId: z.string().trim().min(1).max(128),
  allowedEventTypes: z.array(MeshEventType).min(1),
  issuedAt: z.number().nonnegative(),
  expiresAt: z.number().positive(),
}).strict();
export type ExecutionCapability = z.infer<typeof ExecutionCapability>;

const CapabilityFile = z.object({
  version: z.literal(1),
  capabilities: z.array(ExecutionCapability).max(MAX_CAPABILITIES),
}).strict();

export function meshCapabilityPath(): string {
  return join(configDir(), "mesh-capabilities.json");
}

function readCapabilities(now: number): ExecutionCapability[] {
  try {
    const parsed = CapabilityFile.safeParse(JSON.parse(readFileSync(meshCapabilityPath(), "utf8")));
    if (!parsed.success) return [];
    return parsed.data.capabilities.filter((item) => item.expiresAt > now);
  } catch {
    return [];
  }
}

function writeCapabilities(capabilities: ExecutionCapability[]): void {
  const path = meshCapabilityPath();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      CapabilityFile.parse({ version: 1, capabilities: capabilities.slice(-MAX_CAPABILITIES) }),
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

export type ExecutionScope = {
  execution: ExecutionSessionLink;
  snapshot: MeshSnapshot;
};

/** The one live, enabled coding-agent execution that owns this native session. */
export function liveExecutionScope(sessionId: string): ExecutionScope | undefined {
  const store = localMeshStore();
  for (const projectId of store.projectIds()) {
    const snapshot = store.snapshot(projectId);
    const execution = snapshot?.executions.find((item) =>
      item.sessionId === sessionId && item.endedAt == null);
    if (!snapshot || !execution) continue;
    if (execution.provider === "grok_bot" || !isProviderEnabled(execution.provider)) return undefined;
    return { execution, snapshot };
  }
  return undefined;
}

/** Mint or reuse the capability for one attributed session. */
export function executionCapabilityFor(
  sessionId: string,
  now = Date.now(),
): ExecutionCapability | undefined {
  const scope = liveExecutionScope(sessionId);
  if (!scope) return undefined;
  const live = readCapabilities(now);
  const existing = live.find((item) =>
    item.sessionId === sessionId
    && item.taskId === scope.execution.taskId
    && item.projectId === scope.snapshot.projectId);
  if (existing) return existing;
  const capability = ExecutionCapability.parse({
    token: randomBytes(32).toString("base64url"),
    provider: scope.execution.provider,
    sessionId,
    projectId: scope.snapshot.projectId,
    taskId: scope.execution.taskId,
    allowedEventTypes: PUBLISHABLE_EVENT_TYPES,
    issuedAt: now,
    expiresAt: now + CAPABILITY_TTL_MS,
  });
  writeCapabilities([...live.filter((item) => item.sessionId !== sessionId), capability]);
  return capability;
}

/** Resolve a presented capability; an ended or disabled execution resolves to nothing. */
export function resolveExecutionCapability(
  token: unknown,
  now = Date.now(),
): ExecutionCapability | undefined {
  const value = String(token ?? "").trim();
  if (!value) return undefined;
  const capability = readCapabilities(now).find((item) => item.token === value);
  if (!capability) return undefined;
  const scope = liveExecutionScope(capability.sessionId);
  if (!scope
    || scope.snapshot.projectId !== capability.projectId
    || scope.execution.taskId !== capability.taskId) return undefined;
  return capability;
}
