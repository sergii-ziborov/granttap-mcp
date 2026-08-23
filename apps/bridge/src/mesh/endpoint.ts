import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openWithTransferKey } from "../../../../packages/core/crypto";
import type { PeerConfig } from "../../../../packages/core/relay-client";
import {
  MeshActor,
  MeshEndpoint,
  MeshEndpointPolicy,
  MeshOperation,
  MeshScopedCredential,
  type MeshOperation as MeshOperationValue,
} from "../../../../packages/protocol/schema";
import { configDir } from "../config";
import { localMeshStore } from "./local";

const PairingConfig = z.object({
  relayUrl: z.string().url(),
  room: z.string().regex(/^[a-f0-9]{16,64}$/),
  role: z.literal("machine"),
  deviceName: z.string().trim().min(1).max(160),
  senderId: z.string().trim().min(1).max(180),
  myPublicKey: z.string().min(43).max(44),
  mySecretKey: z.string().min(43).max(44),
  peerPublicKey: z.string().min(43).max(44),
  pushAuth: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const GrokBotEndpointBundleSchema = z.object({
  version: z.literal(1),
  endpoint: MeshEndpoint,
  credential: MeshScopedCredential,
  actors: z.array(MeshActor).min(1).max(32),
  pairing: PairingConfig,
  policy: MeshEndpointPolicy,
  inviteExpiresAt: z.number().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.endpoint.endpointId !== value.credential.endpointId
    || value.endpoint.credentialId !== value.credential.credentialId
    || value.policy.endpointId !== value.endpoint.endpointId
    || value.policy.credentialId !== value.credential.credentialId
    || value.actors.some((actor) => actor.endpointId !== value.endpoint.endpointId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: "endpoint scope mismatch" });
  }
  const publicKey = Buffer.from(value.pairing.myPublicKey, "base64").toString("base64url");
  if (publicKey !== value.endpoint.publicKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pairing"], message: "endpoint key mismatch" });
  }
});

export type GrokBotEndpointBundle = z.infer<typeof GrokBotEndpointBundleSchema> & {
  pairing: PeerConfig;
};

export function grokBotEndpointPath(): string {
  return join(configDir(), "grok-bot-endpoint.json");
}

export function loadGrokBotEndpoint(): GrokBotEndpointBundle | null {
  try {
    const parsed = GrokBotEndpointBundleSchema.safeParse(
      JSON.parse(readFileSync(grokBotEndpointPath(), "utf8")),
    );
    return parsed.success ? parsed.data as GrokBotEndpointBundle : null;
  } catch {
    return null;
  }
}

export function saveGrokBotEndpoint(input: GrokBotEndpointBundle): void {
  const value = GrokBotEndpointBundleSchema.parse(input);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(grokBotEndpointPath(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(grokBotEndpointPath(), 0o600);
}

type Authorization = {
  actorId: string;
  projectId: string;
  taskId?: string;
  operation: MeshOperationValue;
  now?: number;
};

export function authorizeGrokBotOperation(input: Authorization): GrokBotEndpointBundle {
  MeshOperation.parse(input.operation);
  const bundle = loadGrokBotEndpoint();
  if (!bundle) throw new Error("Grok Bot endpoint is not connected");
  const at = input.now ?? Date.now();
  if (bundle.endpoint.status === "revoked" || bundle.credential.status === "revoked"
    || bundle.policy.status === "revoked") throw new Error("Grok Bot credential is revoked");
  if (bundle.credential.expiresAt <= at) throw new Error("Grok Bot credential expired");
  if (!bundle.policy.enabled) throw new Error("Project Mesh is disabled");
  const actor = bundle.actors.find((item) => item.actorId === input.actorId);
  const actorPolicy = bundle.policy.actors.find((item) => item.actorId === input.actorId);
  if (!actor || !actor.enabled || actorPolicy?.enabled !== true) throw new Error("Mesh actor is disabled");
  if (!bundle.credential.projectIds.includes(input.projectId)
    || !bundle.policy.projectIds.includes(input.projectId)) throw new Error("Project scope is not allowed");
  if (input.taskId && bundle.credential.taskIds
    && !bundle.credential.taskIds.includes(input.taskId)) throw new Error("Task scope is not allowed");
  if (!bundle.credential.operations.includes(input.operation)) throw new Error("Mesh operation is not allowed");
  return bundle;
}

export function applyGrokBotPolicy(input: z.infer<typeof MeshEndpointPolicy>): void {
  const policy = MeshEndpointPolicy.parse(input);
  const bundle = loadGrokBotEndpoint();
  if (!bundle || policy.endpointId !== bundle.endpoint.endpointId
    || policy.credentialId !== bundle.credential.credentialId) {
    throw new Error("Mesh endpoint policy does not match this credential");
  }
  if (policy.revision <= bundle.policy.revision) return;
  const revoked = policy.status === "revoked";
  bundle.policy = policy;
  bundle.endpoint.status = revoked ? "revoked" : "active";
  bundle.credential.status = revoked ? "revoked" : "active";
  bundle.credential.revokedAt = revoked ? policy.createdAt : undefined;
  bundle.credential.projectIds = [...policy.projectIds];
  bundle.actors = bundle.actors.map((actor) => ({
    ...actor,
    enabled: policy.actors.find((item) => item.actorId === actor.actorId)?.enabled ?? false,
  }));
  if (revoked) {
    const owners = new Set(bundle.credential.projectIds.flatMap((projectId) =>
      (localMeshStore().snapshot(projectId)?.executions ?? [])
        .filter((execution) => execution.provider === "grok_bot"
          && bundle.actors.some((actor) => actor.actorId === execution.actorId))
        .map((execution) => execution.sessionId)
    ));
    localMeshStore().releaseClaimsByOwners(owners);
  }
  saveGrokBotEndpoint(bundle);
}

function inviteParts(uri: string): { base: string; mailbox: string; key: string } {
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error("Mesh Invite is invalid"); }
  if (url.protocol !== "granttap:" || url.hostname !== "mesh-invite"
    || url.searchParams.get("v") !== "1") throw new Error("Mesh Invite is invalid");
  const base = url.searchParams.get("u") ?? "";
  const mailbox = url.searchParams.get("m") ?? "";
  const key = url.searchParams.get("k") ?? "";
  const baseUrl = new URL(base);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if ((baseUrl.protocol !== "https:" && !(loopback && baseUrl.protocol === "http:"))
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    || !/^[a-f0-9]{32}$/.test(mailbox) || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
    throw new Error("Mesh Invite is invalid");
  }
  return { base: baseUrl.toString().replace(/\/$/, ""), mailbox, key };
}

export async function connectGrokBotInvite(uri: string, now = Date.now()): Promise<GrokBotEndpointBundle> {
  const existing = loadGrokBotEndpoint();
  if (existing && existing.credential.status !== "revoked") {
    throw new Error("Grok Bot is already connected");
  }
  const { base, mailbox, key } = inviteParts(uri);
  const response = await fetch(`${base}/pair/${mailbox}`, {
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (response.status === 404 || response.status === 410) throw new Error("Mesh Invite expired or was already used");
  if (!response.ok) throw new Error(`Mesh Invite relay returned HTTP ${response.status}`);
  const blob = await response.json() as { nonce?: unknown; box?: unknown };
  if (typeof blob.nonce !== "string" || typeof blob.box !== "string") throw new Error("Mesh Invite is invalid");
  const opened = openWithTransferKey(blob.nonce, blob.box, key);
  const parsed = GrokBotEndpointBundleSchema.safeParse(opened);
  if (!parsed.success || parsed.data.inviteExpiresAt <= now
    || parsed.data.credential.expiresAt <= now) throw new Error("Mesh Invite expired or is invalid");
  if (existing?.credential.credentialId === parsed.data.credential.credentialId) {
    throw new Error("Revoked credentials cannot be reused");
  }
  saveGrokBotEndpoint(parsed.data as GrokBotEndpointBundle);
  return parsed.data as GrokBotEndpointBundle;
}

export function hasGrokBotEndpoint(): boolean {
  return existsSync(grokBotEndpointPath()) && loadGrokBotEndpoint() != null;
}
