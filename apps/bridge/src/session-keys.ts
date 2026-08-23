import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTransferKey } from "../../../packages/core/crypto";
import { RelayClient, type SendOptions } from "../../../packages/core/relay-client";
import type { MeshEvent, MeshSnapshot, Payload, Role } from "../../../packages/protocol/schema";
import { configDir } from "./config";

type SessionKeys = Record<string, string>;

export function sessionKeysPath(): string {
  return join(configDir(), "session-keys.json");
}

function load(): SessionKeys {
  try {
    const value = JSON.parse(readFileSync(sessionKeysPath(), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length >= 43 && entry[1].length <= 44));
  } catch {
    return {};
  }
}

function save(keys: SessionKeys): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(sessionKeysPath(), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(sessionKeysPath(), 0o600);
}

export function sessionKey(sessionId: string): string {
  const keys = load();
  if (keys[sessionId]) return keys[sessionId]!;
  const key = generateTransferKey();
  keys[sessionId] = key;
  save(keys);
  return key;
}

export function primeSessionKeys(client: RelayClient): void {
  if (!existsSync(sessionKeysPath())) return;
  for (const [sessionId, key] of Object.entries(load())) client.setSessionKey(sessionId, key);
}

/**
 * Grant the task key over the already authenticated device box, then send the
 * payload under that independent key. Cloudflare sees neither key nor layer.
 */
export async function sendSessionPayload(
  client: RelayClient,
  payload: Payload,
  sessionId: string,
  to: Role | "all" = "phone",
  options: SendOptions = {},
): Promise<void> {
  await sendScopedPayload(client, payload, sessionId, undefined, to, options);
}

export async function sendMeshPayload(
  client: RelayClient,
  payload: MeshEvent | MeshSnapshot,
  to: Role | "all" = "phone",
  options: SendOptions = {},
): Promise<void> {
  const purpose = payload.type === "mesh.snapshot" ? "project" : "task";
  await sendScopedPayload(client, payload, payload.sessionId, purpose, to, options);
}

async function sendScopedPayload(
  client: RelayClient,
  payload: Payload,
  sessionId: string,
  purpose: "task" | "project" | undefined,
  to: Role | "all",
  options: SendOptions,
): Promise<void> {
  const key = sessionKey(sessionId);
  client.setSessionKey(sessionId, key);
  await client.send({
    type: "session.key.grant",
    sessionId,
    key,
    purpose,
    createdAt: Date.now(),
  }, to, { ttlMs: options.ttlMs });
  await client.sendSession(payload, sessionId, to, options);
}
