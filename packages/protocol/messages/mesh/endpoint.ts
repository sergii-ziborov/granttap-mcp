import { z } from "zod";

export const Identifier = z.string().trim().min(1).max(128);
export const Label = z.string().trim().min(1).max(160);
export const Detail = z.string().trim().min(1).max(1_000);
export const Path = z.string().trim().min(1).max(1_024);
export const GitSha = z.string().regex(/^[0-9a-f]{7,64}$/i);

export const MeshProvider = z.enum(["claude", "codex", "cursor", "grok"]);
export type MeshProvider = z.infer<typeof MeshProvider>;
export const MeshExecutionProvider = z.union([MeshProvider, z.literal("grok_bot")]);
export type MeshExecutionProvider = z.infer<typeof MeshExecutionProvider>;

export const MeshEndpoint = z.object({
  endpointId: Identifier,
  kind: z.literal("grok_bot_cloud"),
  displayName: Label,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43,44}$/),
  credentialId: Identifier,
  status: z.enum(["pending", "active", "revoked"]),
  createdAt: z.number().nonnegative(),
}).strict();
export type MeshEndpoint = z.infer<typeof MeshEndpoint>;

export const MeshActor = z.object({
  actorId: Identifier,
  endpointId: Identifier,
  kind: z.literal("persistent_agent"),
  displayName: Label,
  status: z.enum(["idle", "working", "blocked", "offline"]),
  enabled: z.boolean(),
}).strict();
export type MeshActor = z.infer<typeof MeshActor>;

export const MeshOperation = z.enum([
  "status", "task", "claim", "release", "progress", "question", "answer",
  "handoff", "accept_handoff", "reject_handoff", "artifact_ready", "complete",
]);
export type MeshOperation = z.infer<typeof MeshOperation>;

export const MeshScopedCredential = z.object({
  credentialId: Identifier,
  endpointId: Identifier,
  status: z.enum(["active", "revoked"]),
  projectIds: z.array(Identifier).min(1).max(64),
  taskIds: z.array(Identifier).max(256).optional(),
  operations: z.array(MeshOperation).min(1).max(12),
  issuedAt: z.number().nonnegative(),
  expiresAt: z.number().positive(),
  revokedAt: z.number().nonnegative().optional(),
}).strict();
export type MeshScopedCredential = z.infer<typeof MeshScopedCredential>;

export const MeshEndpointPolicy = z.object({
  type: z.literal("mesh.endpoint.policy"),
  endpointId: Identifier,
  credentialId: Identifier,
  enabled: z.boolean(),
  status: z.enum(["active", "revoked"]),
  projectIds: z.array(Identifier).max(64),
  actors: z.array(z.object({
    actorId: Identifier,
    enabled: z.boolean(),
  }).strict()).max(32),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
}).strict();
export type MeshEndpointPolicy = z.infer<typeof MeshEndpointPolicy>;
