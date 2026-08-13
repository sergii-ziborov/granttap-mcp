import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { generateKeyPair, randomId } from "../../../../packages/core/crypto";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import { configDir } from "./paths";

export function saveConfig(path: string, cfg: PeerConfig): void {
  mkdirSync(configDir(), { recursive: true });
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
      // Existing invalid pairings remain best-effort backup candidates.
    }
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadConfig(path: string): PeerConfig {
  return JSON.parse(readFileSync(path, "utf8")) as PeerConfig;
}

const b64url = (value: string): string =>
  value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64url = (value: string): string => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
};

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
  return /^[A-Za-z0-9_-]{43,44}$/.test(value)
    && Buffer.from(unb64url(value), "base64").length === 32;
}

export function pairingUri(cfg: PeerConfig): string {
  const query = new URLSearchParams({
    v: "1",
    u: cfg.relayUrl,
    r: cfg.room,
    s: b64url(cfg.mySecretKey),
    p: b64url(cfg.peerPublicKey),
    k: b64url(cfg.myPublicKey),
    i: cfg.senderId,
    ...(cfg.pushAuth ? { a: cfg.pushAuth } : {}),
  });
  return `granttap://pair?${query.toString()}`;
}

export function parsePairingUri(uri: string): PeerConfig | null {
  let query: URLSearchParams;
  try {
    const url = new URL(uri);
    if (url.protocol !== "granttap:" && url.protocol !== "nodvox:") return null;
    query = url.searchParams;
  } catch {
    return null;
  }
  const get = (key: string) => query.get(key) ?? "";
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

export function createPairing(relayUrl: string): {
  machineCfg: PeerConfig;
  phoneCfg: PeerConfig;
} {
  relayUrl = normalizeRelayUrl(relayUrl);
  const machine = generateKeyPair();
  const phone = generateKeyPair();
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
