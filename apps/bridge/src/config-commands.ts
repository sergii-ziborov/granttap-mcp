import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigSet } from "../../../packages/protocol/schema";
import { configDir } from "./config/paths";
import { loadRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "./config/runtime";
import { writePrivateFile } from "./config/write-private";
import { acceptInstanceEpoch } from "./instance-epoch";

const CLOCK_SKEW_MS = 2 * 60_000;
const MAX_COMMANDS = 256;

export type ConfigCommandResult =
  | { kind: "applied"; revision: number }
  | { kind: "replay"; revision: number }
  | { kind: "rejected"; reason: "expired" | "conflict" | "digest_mismatch" | "legacy_blocked" | "stale_instance" };

type CommandRecord = {
  operationId: string;
  digest: string;
  revision: number;
};

type CommandState = {
  revision: number;
  requireFreshCommands: boolean;
  commands: CommandRecord[];
};

const EMPTY: CommandState = { revision: 0, requireFreshCommands: false, commands: [] };

export function configCommandsPath(): string {
  return join(configDir(), "config-commands.json");
}

export function configMutationDigest(message: ConfigSet): string {
  const body = {
    enabled: message.enabled ?? null,
    excludeSession: message.excludeSession ?? null,
    includeSession: message.includeSession ?? null,
    autoAcceptDefault: message.autoAcceptDefault ?? null,
    autoAcceptSession: message.autoAcceptSession ?? null,
    autoAcceptPaused: message.autoAcceptPaused ?? null,
    provider: message.provider ?? null,
    providerEnabled: message.providerEnabled ?? null,
    meshEnabled: message.meshEnabled ?? null,
    contextCompilerEnabled: message.contextCompilerEnabled ?? null,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function loadConfigCommandState(): CommandState {
  try {
    const raw = JSON.parse(readFileSync(configCommandsPath(), "utf8")) as Partial<CommandState>;
    return {
      revision: typeof raw.revision === "number" && raw.revision >= 0 ? raw.revision : 0,
      requireFreshCommands: raw.requireFreshCommands === true,
      commands: Array.isArray(raw.commands)
        ? raw.commands.filter((item): item is CommandRecord =>
          item != null
          && typeof item.operationId === "string"
          && typeof item.digest === "string"
          && typeof item.revision === "number")
        : [],
    };
  } catch {
    return { ...EMPTY, commands: [] };
  }
}

export function setRequireFreshCommands(required: boolean): void {
  const state = loadConfigCommandState();
  state.requireFreshCommands = required;
  writePrivateFile(configCommandsPath(), `${JSON.stringify(state, null, 2)}\n`);
}

function applyRuntimePatch(message: ConfigSet): void {
  const runtime = loadRuntimeConfig();
  if (typeof message.enabled === "boolean") runtime.enabled = message.enabled;
  if (message.excludeSession && !runtime.excludedSessions.includes(message.excludeSession)) {
    runtime.excludedSessions.push(message.excludeSession);
  }
  if (message.includeSession) {
    runtime.excludedSessions = runtime.excludedSessions.filter((id) => id !== message.includeSession);
  }
  if (message.autoAcceptDefault) runtime.autoAcceptDefault = message.autoAcceptDefault;
  if (typeof message.autoAcceptPaused === "boolean") {
    runtime.autoAcceptPaused = message.autoAcceptPaused;
  }
  if (message.autoAcceptSession) {
    const { sessionId, level } = message.autoAcceptSession;
    if (level == null) delete runtime.autoAcceptBySession[sessionId];
    else runtime.autoAcceptBySession[sessionId] = level;
  }
  if (message.provider && typeof message.providerEnabled === "boolean") {
    runtime.providerSettings = {
      ...runtime.providerSettings,
      [message.provider]: message.providerEnabled,
    };
  }
  if (typeof message.meshEnabled === "boolean") runtime.meshEnabled = message.meshEnabled;
  if (typeof message.contextCompilerEnabled === "boolean") {
    runtime.contextCompilerEnabled = message.contextCompilerEnabled;
  }
  saveRuntimeConfig(runtime);
}

export function applyConfigSet(
  message: ConfigSet,
  now = Date.now(),
): ConfigCommandResult {
  const state = loadConfigCommandState();
  const digest = configMutationDigest(message);
  if (message.payloadDigest && message.payloadDigest.toLowerCase() !== digest) {
    return { kind: "rejected", reason: "digest_mismatch" };
  }
  if (message.expiresAt != null && message.expiresAt + CLOCK_SKEW_MS <= now) {
    return { kind: "rejected", reason: "expired" };
  }
  if (message.operationId) {
    const previous = state.commands.find((item) => item.operationId === message.operationId);
    if (previous) {
      if (previous.digest !== digest) return { kind: "rejected", reason: "digest_mismatch" };
      return { kind: "replay", revision: previous.revision };
    }
    if (message.baseRevision != null && message.baseRevision !== state.revision) {
      return { kind: "rejected", reason: "conflict" };
    }
  } else if (state.requireFreshCommands) {
    return { kind: "rejected", reason: "legacy_blocked" };
  }
  if (!acceptInstanceEpoch(message.instanceEpoch, state.requireFreshCommands)) {
    return { kind: "rejected", reason: "stale_instance" };
  }
  applyRuntimePatch(message);
  state.revision += 1;
  if (message.operationId) {
    state.commands = [...state.commands, {
      operationId: message.operationId, digest, revision: state.revision,
    }].slice(-MAX_COMMANDS);
  }
  writePrivateFile(configCommandsPath(), `${JSON.stringify(state, null, 2)}\n`);
  return { kind: "applied", revision: state.revision };
}

export function currentConfigRevision(): number {
  return loadConfigCommandState().revision;
}

export type { RuntimeConfig };
