import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./write-private";
import type {
  AgentAccess,
  CodingAgent,
  ProviderRuntimeSettings,
} from "../../../../packages/protocol/schema";
import {
  classifyAction,
  isAutoAcceptLevel,
  resolveAutoAcceptLevel,
  shouldAutoAllow,
  type AutoAcceptLevel,
} from "../policy";
import { loadStoreState } from "../mesh/store-state";
import { configDir, runtimeConfigPath } from "./paths";

export type RuntimeConfig = {
  enabled: boolean;
  excludedSessions: string[];
  sessionAccess: Record<string, AgentAccess>;
  autoAcceptDefault: AutoAcceptLevel;
  autoAcceptBySession: Record<string, AutoAcceptLevel>;
  autoAcceptByProject: Record<string, AutoAcceptLevel>;
  autoAcceptPaused: boolean;
  sessionMcpDisabled: Record<string, string[]>;
  sessionSkillsDisabled: Record<string, string[]>;
  sessionShellDisabled: string[];
  /** Chats held from the phone: every tool call is refused until resumed. */
  pausedSessions: string[];
  providerSettings: ProviderRuntimeSettings;
  meshEnabled: boolean;
  /** Off by default: compile a bounded Mesh packet for the calling Task. */
  contextCompilerEnabled: boolean;
  /** Absolute path to the separately distributed GrantTap Engine binary. */
  enginePath: string | null;
  /** Expected SHA-256 of that binary, in lowercase hex. */
  engineSha256: string | null;
};

const DEFAULT_RUNTIME: RuntimeConfig = {
  enabled: true,
  excludedSessions: [],
  sessionAccess: {},
  autoAcceptDefault: "except_push",
  autoAcceptBySession: {},
  autoAcceptByProject: {},
  autoAcceptPaused: false,
  sessionMcpDisabled: {},
  sessionSkillsDisabled: {},
  sessionShellDisabled: [],
  pausedSessions: [],
  providerSettings: { claude: true, codex: true, cursor: true, grok: true },
  meshEnabled: true,
  contextCompilerEnabled: false,
  enginePath: null,
  engineSha256: null,
};

function parseProviderSettings(raw: unknown): ProviderRuntimeSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_RUNTIME.providerSettings };
  }
  const value = raw as Record<string, unknown>;
  return {
    claude: value.claude !== false,
    codex: value.codex !== false,
    cursor: value.cursor !== false,
    grok: value.grok !== false,
  };
}

export function boundedIdentifier(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= maxLength ? value : null;
}

export function capabilitySessionId(raw: unknown): string | null {
  return boundedIdentifier(raw, 256);
}

export function capabilityName(raw: unknown): string | null {
  return boundedIdentifier(raw, 160);
}

function parseByLevel(
  raw: unknown,
  maxKeyLength: number,
): Record<string, AutoAcceptLevel> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AutoAcceptLevel> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = boundedIdentifier(key, maxKeyLength);
    if (id && isAutoAcceptLevel(value)) out[id] = value;
  }
  return out;
}

function parseDisabledCapabilities(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string[]> = {};
  for (const [rawSessionId, names] of Object.entries(raw as Record<string, unknown>)) {
    const sessionId = capabilitySessionId(rawSessionId);
    if (!sessionId || !Array.isArray(names)) continue;
    const clean = [...new Set(
      names.map(capabilityName).filter((name): name is string => name != null),
    )];
    if (clean.length > 0) result[sessionId] = clean;
  }
  return result;
}

function parseSessionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set<string>(
    (raw as unknown[])
      .map(capabilitySessionId)
      .filter((sessionId): sessionId is string => sessionId != null),
  )];
}

/** Only an absolute path can be verified, so a relative one is not kept. */
function parseEnginePath(raw: unknown): string | null {
  return typeof raw === "string" && raw.startsWith("/") && raw.length <= 1024 ? raw : null;
}

function parseEngineChecksum(raw: unknown): string | null {
  return typeof raw === "string" && /^[a-f\d]{64}$/i.test(raw) ? raw.toLowerCase() : null;
}

/** A declaration is usable only when both halves survived parsing. */
export function verifiableEngine(
  config: Pick<RuntimeConfig, "enginePath" | "engineSha256">,
): { path: string; sha256: string } | null {
  const path = parseEnginePath(config.enginePath);
  const sha256 = parseEngineChecksum(config.engineSha256);
  return path && sha256 ? { path, sha256 } : null;
}

export function loadRuntimeConfig(): RuntimeConfig {
  try {
    const raw = JSON.parse(readFileSync(runtimeConfigPath(), "utf8"));
    const sessionAccess = Object.fromEntries(
      Object.entries(raw.sessionAccess ?? {}).filter((entry): entry is [string, AgentAccess] =>
        ["read-only", "workspace", "full"].includes(String(entry[1])),
      ),
    );
    return {
      enabled: raw.enabled !== false,
      excludedSessions: Array.isArray(raw.excludedSessions) ? raw.excludedSessions.map(String) : [],
      sessionAccess,
      autoAcceptDefault: isAutoAcceptLevel(raw.autoAcceptDefault)
        ? raw.autoAcceptDefault
        : DEFAULT_RUNTIME.autoAcceptDefault,
      autoAcceptBySession: parseByLevel(raw.autoAcceptBySession, 256),
      autoAcceptByProject: parseByLevel(raw.autoAcceptByProject, 128),
      autoAcceptPaused: raw.autoAcceptPaused === true,
      sessionMcpDisabled: parseDisabledCapabilities(raw.sessionMcpDisabled),
      sessionSkillsDisabled: parseDisabledCapabilities(raw.sessionSkillsDisabled),
      sessionShellDisabled: parseSessionList(raw.sessionShellDisabled),
      pausedSessions: parseSessionList(raw.pausedSessions),
      providerSettings: parseProviderSettings(raw.providerSettings),
      meshEnabled: raw.meshEnabled !== false,
      contextCompilerEnabled: raw.contextCompilerEnabled === true,
      enginePath: parseEnginePath(raw.enginePath),
      engineSha256: parseEngineChecksum(raw.engineSha256),
    };
  } catch {
    return {
      ...DEFAULT_RUNTIME,
      sessionAccess: {},
      autoAcceptBySession: {},
      autoAcceptByProject: {},
      sessionMcpDisabled: {},
      sessionSkillsDisabled: {},
      sessionShellDisabled: [],
      pausedSessions: [],
      providerSettings: { ...DEFAULT_RUNTIME.providerSettings },
      meshEnabled: true,
      contextCompilerEnabled: false,
    };
  }
}

export function isProviderEnabled(provider: CodingAgent): boolean {
  return loadRuntimeConfig().providerSettings[provider];
}

export function isMeshEnabled(): boolean {
  return loadRuntimeConfig().meshEnabled;
}

export function isContextCompilerEnabled(): boolean {
  const flag = process.env.GRANTTAP_CONTEXT_COMPILER?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return loadRuntimeConfig().contextCompilerEnabled;
}

export function saveRuntimeConfig(cfg: Partial<RuntimeConfig>): void {
  const merged: RuntimeConfig = { ...loadRuntimeConfig(), ...cfg };
  writePrivateFile(runtimeConfigPath(), JSON.stringify(merged, null, 2) + "\n");
}

function projectIdForSession(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const state = loadStoreState(join(configDir(), "project-mesh.json"));
    const execution = state.executions.find((item) => item.sessionId === sessionId);
    if (!execution) return undefined;
    return state.tasks.find((item) => item.taskId === execution.taskId)?.projectId;
  } catch {
    return undefined;
  }
}

export function autoAcceptLevelFor(sessionId: string | null | undefined): AutoAcceptLevel {
  const cfg = loadRuntimeConfig();
  return resolveAutoAcceptLevel({
    paused: cfg.autoAcceptPaused,
    defaultLevel: cfg.autoAcceptDefault,
    bySession: cfg.autoAcceptBySession,
    byProject: cfg.autoAcceptByProject,
    sessionId: sessionId ?? undefined,
    projectId: projectIdForSession(sessionId),
  });
}

export function shouldAutoAcceptTool(
  sessionId: string | null | undefined,
  tool: string,
  command: string | null | undefined,
): boolean {
  const level = autoAcceptLevelFor(sessionId);
  return shouldAutoAllow(level, classifyAction(tool, command ?? undefined));
}

export function isGatingSkipped(sessionId: string | null | undefined): boolean {
  const cfg = loadRuntimeConfig();
  if (!cfg.enabled) return true;
  return sessionId != null && cfg.excludedSessions.includes(sessionId);
}
