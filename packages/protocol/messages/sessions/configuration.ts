import { z } from "zod";
import { AutoAcceptLevel, CodingAgent } from "../primitives";

export const CortexIntegrationSet = z.object({
  projectId: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  maxTokens: z.number().int().min(512).max(262_144),
}).strict();
export type CortexIntegrationSet = z.infer<typeof CortexIntegrationSet>;

export const ConfigSet = z.object({
  type: z.literal("config.set"),
  enabled: z.boolean().optional(),
  excludeSession: z.string().optional(),
  includeSession: z.string().optional(),
  autoAcceptDefault: AutoAcceptLevel.nullish(),
  autoAcceptSession: z.object({
    sessionId: z.string(),
    level: AutoAcceptLevel.nullable(),
    authorizeProjectAsk: z.boolean().optional(),
    expectedPolicyRevision: z.number().int().nonnegative().optional(),
    approvalRequestId: z.string().min(1).max(256).optional(),
  }).nullish(),
  autoAcceptProject: z.object({
    projectId: z.string().trim().min(1).max(128),
    level: AutoAcceptLevel.nullable(),
  }).nullish(),
  autoAcceptPaused: z.boolean().nullish(),
  provider: CodingAgent.optional(),
  providerEnabled: z.boolean().optional(),
  meshEnabled: z.boolean().optional(),
  contextCompilerEnabled: z.boolean().optional(),
  cortexIntegration: CortexIntegrationSet.optional(),
  createdAt: z.number(),
  operationId: z.string().trim().min(1).max(128).optional(),
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  expiresAt: z.number().positive().optional(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  instanceEpoch: z.string().trim().min(8).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.provider == null) !== (value.providerEnabled == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.provider == null ? "provider" : "providerEnabled"],
      message: "provider and providerEnabled must be sent together",
    });
  }
});
export type ConfigSet = z.infer<typeof ConfigSet>;

export const ConfigCommandResult = z.object({
  type: z.literal("config.command.result"),
  operationId: z.string().min(1).max(128),
  ok: z.boolean(),
  reason: z.string().max(128).optional(),
  sessionId: z.string().optional(),
  level: AutoAcceptLevel.optional(),
  revision: z.number().int().nonnegative().optional(),
  createdAt: z.number(),
}).strict();
export type ConfigCommandResult = z.infer<typeof ConfigCommandResult>;
