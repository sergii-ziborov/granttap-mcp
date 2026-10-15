import { z } from "zod";
import { Identifier, Label, MeshProvider } from "../endpoint";

/**
 * One SKILL.md the Project catalog published. Presence is not permission;
 * Governance is the only authority for what may run.
 */
export const SharedSkillState = z.enum(["discovered", "installed", "available", "used", "conflict", "unknown"]);
export type SharedSkillState = z.infer<typeof SharedSkillState>;
export const SharedSkill = z.object({
  name: z.string().trim().min(1).max(160),
  endpointId: Identifier.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  digest: z.string().trim().min(1).max(128).optional(),
  source: z.string().trim().min(1).max(240).optional(),
  state: SharedSkillState.optional(),
}).strict();
export type SharedSkill = z.infer<typeof SharedSkill>;

export const ProviderAccountUsage = z.object({
  provider: MeshProvider,
  limitId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/),
  observedAt: z.number().nonnegative(),
  windows: z.array(z.object({
    id: z.enum(["primary", "secondary"]),
    usedPercent: z.number().min(0).max(100),
    windowMinutes: z.number().int().positive(),
    resetsAt: z.number().positive(),
  }).strict()).max(2),
}).strict();
export type ProviderAccountUsage = z.infer<typeof ProviderAccountUsage>;

export const AdvertisedModel = z.object({
  modelId: z.string().trim().min(1).max(160),
  provider: MeshProvider,
  endpointId: Identifier,
  source: z.enum(["observed", "advertised"]),
  label: Label.optional(),
  description: z.string().trim().min(1).max(240).optional(),
  priority: z.number().int().nonnegative().max(10_000).optional(),
  observedAt: z.number().nonnegative(),
}).strict();
export type AdvertisedModel = z.infer<typeof AdvertisedModel>;

export const EndpointModelCatalog = z.object({
  endpointId: Identifier,
  observedAt: z.number().nonnegative(),
  stale: z.boolean().optional(),
  models: z.array(AdvertisedModel).max(256),
  reason: z.string().trim().min(1).max(240).optional(),
  accountUsage: z.array(ProviderAccountUsage).max(16).optional(),
}).strict();
export type EndpointModelCatalog = z.infer<typeof EndpointModelCatalog>;

