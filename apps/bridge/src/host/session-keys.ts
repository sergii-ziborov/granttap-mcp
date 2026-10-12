import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSessionKeys, persistedSessionKey } from "./session-key-store";
import { RelayClient, type SendOptions } from "../../../../packages/core/relay-client";
import type {
  MeshClaimReleaseResult,
  MeshEvent,
  MeshSnapshot,
  MeshInvocationPage,
  Payload,
  ProjectPolicyPayload,
  Role,
} from "../../../../packages/protocol/schema";
import { configDir } from "../config";

export function sessionKeysPath(): string {
  return join(configDir(), "session-keys.json");
}

export function sessionKey(sessionId: string): string {
  return persistedSessionKey(sessionKeysPath(), sessionId);
}

export function primeSessionKeys(client: RelayClient): void {
  if (!existsSync(sessionKeysPath())) return;
  for (const [sessionId, key] of Object.entries(loadSessionKeys(sessionKeysPath()))) client.setSessionKey(sessionId, key);
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
  await sendScopedPayload({ client, payload, sessionId, to, options });
}

export async function sendMeshPayload(
  client: RelayClient,
  payload: MeshEvent | MeshSnapshot,
  to: Role | "all" = "phone",
  options: SendOptions = {},
): Promise<void> {
  const purpose = payload.type === "mesh.snapshot" ? "project" : "task";
  await sendScopedPayload({ client, payload, sessionId: payload.sessionId, purpose, to, options });
}

export async function sendProjectPayload(
  client: RelayClient,
  payload: ProjectPolicyPayload | MeshClaimReleaseResult | MeshInvocationPage,
  to: Role | "all" = "phone",
  options: SendOptions = {},
): Promise<void> {
  await sendScopedPayload({
    client, payload, sessionId: payload.projectId, purpose: "project", to, options,
  });
}

async function sendScopedPayload(input: {
  client: RelayClient;
  payload: Payload;
  sessionId: string;
  purpose?: "task" | "project";
  to: Role | "all";
  options: SendOptions;
}): Promise<void> {
  const { client, payload, sessionId, purpose, to, options } = input;
  const key = sessionKey(sessionId);
  client.setSessionKey(sessionId, key);
  await client.send({
    type: "session.key.grant",
    sessionId,
    key,
    purpose,
    createdAt: Date.now(),
  }, to, { ttlMs: options.ttlMs, peerPublicKey: options.peerPublicKey });
  await client.sendSession(payload, sessionId, to, options);
}
