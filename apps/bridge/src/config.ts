/**
 * Device config + pairing.
 *
 * A "pairing" is two halves of one E2EE relationship:
 *   - machine.json  stays on the computer (its secret key + the phone's pubkey)
 *   - the phone half is handed to the phone (later via QR; for now a file)
 * Neither half ever contains the other side's secret, and the relay sees no key.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { generateKeyPair, randomId } from "../../../packages/core/crypto";
import type { PeerConfig } from "../../../packages/core/relay-client";
import type { AgentAccess } from "../../../packages/protocol/schema";

export function configDir(): string {
  const overridden = process.env.GRANTTAP_CONFIG_DIR ?? process.env.NODVOX_CONFIG_DIR;
  if (overridden) return overridden;

  const current = join(homedir(), ".granttap");
  const legacy = join(homedir(), ".nodvox");
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      // Same-volume rename keeps the existing pairing keys and their modes intact.
      renameSync(legacy, current);
    } catch {
      // If migration is impossible, keep using the old directory instead of
      // silently generating a new identity and breaking the active pairing.
      return legacy;
    }
  }
  return current;
}

export function machineConfigPath(): string {
  return join(configDir(), "machine.json");
}

// ------------------------------------------------------------- runtime config
//
// The on/off switch and per-session exclusions the hook reads on every call.
// Editable from the phone (a config.set payload the monitor persists here), so
// you can pause gating or exempt a specific chat without touching any files.

import {
  isAutoAcceptLevel,
  type AutoAcceptLevel,
  resolveAutoAcceptLevel,
  shouldAutoAllow,
  shouldAutoAcceptCursorShell,
  isSafeReadonlyShell,
  classifyAction,
} from "./policy";

export type RuntimeConfig = {
  enabled: boolean;
  excludedSessions: string[];
  sessionAccess: Record<string, AgentAccess>;
  /** Default auto-accept level for sessions without an override. */
  autoAcceptDefault: AutoAcceptLevel;
  /** Per-session overrides set from the phone. */
  autoAcceptBySession: Record<string, AutoAcceptLevel>;
  /** When true, treat every session as ask (gating still on). */
  autoAcceptPaused: boolean;
  /** MCP servers denied only for turns delivered by GrantTap into a task. */
  sessionMcpDisabled: Record<string, string[]>;
  /** Skills denied only in the exact originating chat. */
  sessionSkillsDisabled: Record<string, string[]>;
  /** Chats where local shell/CLI execution is disabled. */
  sessionShellDisabled: string[];
};

const DEFAULT_RUNTIME: RuntimeConfig = {
  enabled: true,
  excludedSessions: [],
  sessionAccess: {},
  autoAcceptDefault: "except_push",
  autoAcceptBySession: {},
  autoAcceptPaused: false,
  sessionMcpDisabled: {},
  sessionSkillsDisabled: {},
  sessionShellDisabled: [],
};

export function runtimeConfigPath(): string {
  return join(configDir(), "config.json");
}

function boundedIdentifier(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= maxLength ? value : null;
}

function capabilitySessionId(raw: unknown): string | null {
  return boundedIdentifier(raw, 256);
}

function capabilityName(raw: unknown): string | null {
  return boundedIdentifier(raw, 160);
}

function parseBySession(raw: unknown): Record<string, AutoAcceptLevel> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, AutoAcceptLevel> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isAutoAcceptLevel(value)) out[key] = value;
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
      autoAcceptBySession: parseBySession(raw.autoAcceptBySession),
      autoAcceptPaused: raw.autoAcceptPaused === true,
      sessionMcpDisabled: parseDisabledCapabilities(raw.sessionMcpDisabled),
      sessionSkillsDisabled: parseDisabledCapabilities(raw.sessionSkillsDisabled),
      sessionShellDisabled: Array.isArray(raw.sessionShellDisabled)
        ? [...new Set<string>(
            (raw.sessionShellDisabled as unknown[])
              .map(capabilitySessionId)
              .filter((sessionId): sessionId is string => sessionId != null),
          )]
        : [],
    };
  } catch {
    return {
      ...DEFAULT_RUNTIME,
      sessionAccess: {},
      autoAcceptBySession: {},
      sessionMcpDisabled: {},
      sessionSkillsDisabled: {},
      sessionShellDisabled: [],
    };
  }
}

/** Level for a session after pause / per-session / default resolution. */
export function autoAcceptLevelFor(sessionId: string | null | undefined): AutoAcceptLevel {
  const cfg = loadRuntimeConfig();
  return resolveAutoAcceptLevel({
    paused: cfg.autoAcceptPaused,
    defaultLevel: cfg.autoAcceptDefault,
    bySession: cfg.autoAcceptBySession,
    sessionId: sessionId ?? undefined,
  });
}

/**
 * Whether this tool call should be auto-allowed without phoning home.
 *
 * This is the difference between "GrantTap is a policy layer" and "GrantTap is
 * a single point of failure": at any level above `ask`, routine work never
 * depends on the phone being awake, reachable, or even installed.
 */
export function shouldAutoAcceptTool(
  sessionId: string | null | undefined,
  tool: string,
  command: string | null | undefined,
): boolean {
  const level = autoAcceptLevelFor(sessionId);
  return shouldAutoAllow(level, classifyAction(tool, command ?? undefined));
}

export {
  classifyAction,
  shouldAutoAllow,
  shouldAutoAcceptCursorShell,
  isSafeReadonlyShell,
  type AutoAcceptLevel,
};

/** Phone toggled one MCP server for one exact session. */
export function setSessionMcpAllowed(
  rawSessionId: string,
  rawServerName: string,
  allowed: boolean,
): void {
  const sessionId = capabilitySessionId(rawSessionId);
  const serverName = capabilityName(rawServerName);
  if (!sessionId || !serverName) throw new TypeError("invalid session MCP toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionMcpDisabled[sessionId] ?? []);
  if (allowed) denied.delete(serverName);
  else denied.add(serverName);
  if (denied.size === 0) delete runtime.sessionMcpDisabled[sessionId];
  else runtime.sessionMcpDisabled[sessionId] = [...denied].sort();
  saveRuntimeConfig(runtime);
}

/** Phone toggled one skill for one exact session. */
export function setSessionSkillAllowed(
  rawSessionId: string,
  rawSkillName: string,
  allowed: boolean,
): void {
  const sessionId = capabilitySessionId(rawSessionId);
  const skillName = capabilityName(rawSkillName);
  if (!sessionId || !skillName) throw new TypeError("invalid session skill toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionSkillsDisabled[sessionId] ?? []);
  if (allowed) denied.delete(skillName);
  else denied.add(skillName);
  if (denied.size === 0) delete runtime.sessionSkillsDisabled[sessionId];
  else runtime.sessionSkillsDisabled[sessionId] = [...denied].sort();
  saveRuntimeConfig(runtime);
}

/** Phone toggled shell/CLI for one exact session. */
export function setSessionShellAllowed(rawSessionId: string, allowed: boolean): void {
  const sessionId = capabilitySessionId(rawSessionId);
  if (!sessionId) throw new TypeError("invalid session shell toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionShellDisabled);
  if (allowed) denied.delete(sessionId);
  else denied.add(sessionId);
  runtime.sessionShellDisabled = [...denied].sort();
  saveRuntimeConfig(runtime);
}

export type SessionCapabilityBlock = {
  kind: "mcp" | "skill" | "cli";
  name: string;
  reason: string;
};

function mcpBlock(server: string): SessionCapabilityBlock {
  return {
    kind: "mcp",
    name: server,
    reason: `GrantTap disabled MCP server “${server}” for this chat`,
  };
}

function skillBlock(skill: string): SessionCapabilityBlock {
  return {
    kind: "skill",
    name: skill,
    reason: `GrantTap disabled skill “${skill}” for this chat`,
  };
}

export function blockedSessionMcpServer(
  rawSessionId: string | null | undefined,
  rawServerName: string | null | undefined,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const server = capabilityName(rawServerName);
  if (!sessionId || !server) return null;
  const runtime = loadRuntimeConfig();
  return (runtime.sessionMcpDisabled[sessionId] ?? []).includes(server)
    ? mcpBlock(server)
    : null;
}

export function blockedSessionSkill(
  rawSessionId: string | null | undefined,
  rawSkillName: string | null | undefined,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const skill = capabilityName(rawSkillName);
  if (!sessionId || !skill) return null;
  const runtime = loadRuntimeConfig();
  return (runtime.sessionSkillsDisabled[sessionId] ?? []).includes(skill)
    ? skillBlock(skill)
    : null;
}

const SESSION_CLI_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "powershell",
  "terminal",
  "exec_command",
  "execute_command",
  "local_shell_call",
  "run_command",
  "run_in_terminal",
  "run_terminal_cmd",
  "shell_command",
]);

function isSessionCliTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (SESSION_CLI_TOOL_NAMES.has(normalized)) return true;
  const leaf = normalized.split(/[.:/]/).at(-1);
  return leaf != null && SESSION_CLI_TOOL_NAMES.has(leaf);
}

function mcpServerFromTool(toolName: string): string | null {
  return capabilityName(/^mcp__(.+?)__(.+)$/i.exec(toolName.trim())?.[1]);
}

function skillFromTool(toolName: string, input: unknown): string | null {
  const named = capabilityName(/^(?:skill__|Skill\()(.+?)\)?$/i.exec(toolName.trim())?.[1]);
  if (named) return named;
  if (!/^Skill$/i.test(toolName.trim()) || !input || typeof input !== "object") return null;
  return capabilityName((input as Record<string, unknown>).skill);
}

/** Exact-session capability enforcement. Unscoped or ambiguous calls abstain. */
export function blockedSessionCapability(
  rawSessionId: string | null | undefined,
  rawToolName: string | null | undefined,
  toolInput?: unknown,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const toolName = boundedIdentifier(rawToolName, 240);
  if (!sessionId || !toolName) return null;
  const runtime = loadRuntimeConfig();

  const server = mcpServerFromTool(toolName);
  if (server && (runtime.sessionMcpDisabled[sessionId] ?? []).includes(server)) {
    return mcpBlock(server);
  }
  const skill = skillFromTool(toolName, toolInput);
  if (skill && (runtime.sessionSkillsDisabled[sessionId] ?? []).includes(skill)) {
    return skillBlock(skill);
  }
  if (isSessionCliTool(toolName) && runtime.sessionShellDisabled.includes(sessionId)) {
    return {
      kind: "cli",
      name: "CLI",
      reason: "GrantTap disabled CLI/shell for this chat",
    };
  }
  return null;
}

/**
 * Merge over whatever is already on disk.
 *
 * A writer that only knows its own slice — an older build, a narrow setter, a
 * test — must not erase settings it never heard of. Writing the object whole is
 * how one phone-side MCP toggle could silently wipe the entire auto-accept
 * policy and drop every session back to asking.
 */
export function saveRuntimeConfig(cfg: Partial<RuntimeConfig>): void {
  mkdirSync(configDir(), { recursive: true });
  const merged: RuntimeConfig = { ...loadRuntimeConfig(), ...cfg };
  writeFileSync(runtimeConfigPath(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  chmodSync(runtimeConfigPath(), 0o600);
}

/** True when the hook should stay out of the way for this session. */
export function isGatingSkipped(sessionId: string | null | undefined): boolean {
  const cfg = loadRuntimeConfig();
  if (!cfg.enabled) return true;
  return sessionId != null && cfg.excludedSessions.includes(sessionId);
}

export function phonePairingPath(): string {
  return join(configDir(), "phone.pairing.json");
}

export function saveConfig(path: string, cfg: PeerConfig): void {
  mkdirSync(configDir(), { recursive: true });
  // Never silently destroy the previous room — MCP connect thrash left phones
  // on dead rooms while Mac published elsewhere with nothing to restore.
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as { room?: string };
      const room = typeof prev.room === "string" && prev.room.length >= 8
        ? prev.room.slice(0, 16)
        : "unknown";
      const bak = `${path}.bak-${room}-${Date.now()}`;
      writeFileSync(bak, readFileSync(path), { mode: 0o600 });
      chmodSync(bak, 0o600);
      process.stderr.write(`[granttap] backed up previous pairing → ${bak}\n`);
    } catch {
      /* best-effort */
    }
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // `mode` only applies when creating a file; repair permissive legacy files too.
  chmodSync(path, 0o600);
}

export function loadConfig(path: string): PeerConfig {
  return JSON.parse(readFileSync(path, "utf8")) as PeerConfig;
}

// ---------------------------------------------------------------- pairing URI
//
// The phone half of a pairing, packed into a single scannable URI. `granttap connect`
// renders this as a QR code in the terminal; the app scans it instead of having
// the user paste JSON. Keys are base64url so the URI stays query-safe.

const b64url = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): string => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return t + "=".repeat((4 - (t.length % 4)) % 4);
};

/** Canonicalize relay endpoints and reject schemes that can expose pairing data. */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay URL is invalid");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("relay URL must use wss:// (ws:// is allowed for local development)");
  }
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "ws:" && !loopback) {
    throw new Error("unencrypted ws:// is allowed only for a loopback development relay");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("relay URL must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function validPairingKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,44}$/.test(value) && Buffer.from(unb64url(value), "base64").length === 32;
}

export function pairingUri(cfg: PeerConfig): string {
  const q = new URLSearchParams({
    v: "1",
    u: cfg.relayUrl,
    r: cfg.room,
    s: b64url(cfg.mySecretKey),
    p: b64url(cfg.peerPublicKey),
    k: b64url(cfg.myPublicKey),
    i: cfg.senderId,
    ...(cfg.pushAuth ? { a: cfg.pushAuth } : {}),
  });
  return `granttap://pair?${q.toString()}`;
}

/** Inverse of `pairingUri` — used by tests and by any non-Apple client. */
export function parsePairingUri(uri: string): PeerConfig | null {
  let q: URLSearchParams;
  try {
    const u = new URL(uri);
    if (u.protocol !== "granttap:" && u.protocol !== "nodvox:") return null;
    q = u.searchParams;
  } catch {
    return null;
  }
  const get = (k: string) => q.get(k) ?? "";
  if (get("v") !== "1" || !/^[a-f0-9]{16,64}$/.test(get("r"))) return null;
  if (!["s", "p", "k"].every((key) => validPairingKey(get(key)))) return null;
  if (get("i").length > 180 || (get("a") && !/^[a-f0-9]{64}$/.test(get("a")))) return null;
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(get("u"));
  } catch {
    return null;
  }
  return {
    relayUrl,
    room: get("r"),
    role: "phone",
    deviceName: "phone",
    senderId: get("i") || "phone",
    myPublicKey: unb64url(get("k")),
    mySecretKey: unb64url(get("s")),
    peerPublicKey: unb64url(get("p")),
    pushAuth: get("a") || undefined,
  };
}

/** Create a fresh machine<->phone pairing. */
export function createPairing(relayUrl: string): { machineCfg: PeerConfig; phoneCfg: PeerConfig } {
  relayUrl = normalizeRelayUrl(relayUrl);
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  // 128 bits keeps the relay's TOFU room rendezvous unguessable in practice.
  const room = randomId(16);
  const pushAuth = randomId(32);

  const machineCfg: PeerConfig = {
    relayUrl,
    room,
    role: "machine",
    deviceName: hostname(),
    senderId: randomId(4),
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
    pushAuth,
  };
  const phoneCfg: PeerConfig = {
    relayUrl,
    room,
    role: "phone",
    deviceName: "phone",
    senderId: randomId(4),
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
    pushAuth,
  };
  return { machineCfg, phoneCfg };
}
