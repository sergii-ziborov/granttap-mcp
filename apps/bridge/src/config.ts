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

export type RuntimeConfig = {
  enabled: boolean;
  excludedSessions: string[];
  sessionAccess: Record<string, AgentAccess>;
  /** MCP servers denied only for turns delivered by GrantTap into a task. */
  sessionMcpDisabled: Record<string, string[]>;
};

const DEFAULT_RUNTIME: RuntimeConfig = {
  enabled: true,
  excludedSessions: [],
  sessionAccess: {},
  sessionMcpDisabled: {},
};

export function runtimeConfigPath(): string {
  return join(configDir(), "config.json");
}

export function loadRuntimeConfig(): RuntimeConfig {
  try {
    const raw = JSON.parse(readFileSync(runtimeConfigPath(), "utf8"));
    const sessionAccess = Object.fromEntries(
      Object.entries(raw.sessionAccess ?? {}).filter((entry): entry is [string, AgentAccess] =>
        ["read-only", "workspace", "full"].includes(String(entry[1])),
      ),
    );
    const sessionMcpDisabled = Object.fromEntries(
      Object.entries(raw.sessionMcpDisabled ?? {})
        .filter(([, value]) => Array.isArray(value))
        .map(([sessionId, value]) => [sessionId, [...new Set((value as unknown[]).map(String).filter(Boolean))]]),
    );
    return {
      enabled: raw.enabled !== false,
      excludedSessions: Array.isArray(raw.excludedSessions) ? raw.excludedSessions.map(String) : [],
      sessionAccess,
      sessionMcpDisabled,
    };
  } catch {
    return { ...DEFAULT_RUNTIME };
  }
}

export function saveRuntimeConfig(cfg: RuntimeConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(runtimeConfigPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(runtimeConfigPath(), 0o600);
}

/** True when the hook should stay out of the way for this session. */
export function isGatingSkipped(sessionId: string | undefined): boolean {
  const cfg = loadRuntimeConfig();
  if (!cfg.enabled) return true;
  return sessionId != null && cfg.excludedSessions.includes(sessionId);
}

export function phonePairingPath(): string {
  return join(configDir(), "phone.pairing.json");
}

export function saveConfig(path: string, cfg: PeerConfig): void {
  mkdirSync(configDir(), { recursive: true });
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
