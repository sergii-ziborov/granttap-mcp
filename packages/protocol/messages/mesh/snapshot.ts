import { z } from "zod";
import { Identifier, Label, MeshProvider } from "./endpoint";
import {
  ProjectEnvironment,
  ProjectExecutionPolicy,
  ProjectRestrictionSet,
} from "../project-policy";
import {
  ExecutionSessionLink,
  MeshTask,
  Project,
  ProjectBindingSummary,
  ResourceClaim,
  TaskDependency,
} from "./tasks";
import { MeshEvent } from "./events";

export const IntegrationVia = z.enum(["database", "kafka", "api"]);
export type IntegrationVia = z.infer<typeof IntegrationVia>;
export const IntegrationRelation = z.enum(["produces", "consumes", "calls", "called_by", "shares"]);
export type IntegrationRelation = z.infer<typeof IntegrationRelation>;

/**
 * One edge of the integration map a bound repository keeps in its
 * `WEAVATRIX.md`: the other repository on the far side of a database, a topic,
 * or an API, as that repository states it. Only stated edges travel; nothing is
 * inferred on the way.
 */
export const IntegrationPeer = z.object({
  projectId: Identifier,
  repositoryId: z.string().trim().min(1).max(512),
  peer: Label,
  via: IntegrationVia,
  relation: IntegrationRelation,
  through: Label.optional(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type IntegrationPeer = z.infer<typeof IntegrationPeer>;

/**
 * One SKILL.md the Project catalog published. Presence is not permission;
 * Governance is the only authority for what may run.
 */
export const SharedSkillState = z.enum(["installed", "available", "used", "unknown"]);
export type SharedSkillState = z.infer<typeof SharedSkillState>;
export const SharedSkill = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  digest: z.string().trim().min(1).max(128).optional(),
  source: z.string().trim().min(1).max(240).optional(),
  state: SharedSkillState.optional(),
}).strict();
export type SharedSkill = z.infer<typeof SharedSkill>;

export const AdvertisedModel = z.object({
  modelId: z.string().trim().min(1).max(160),
  provider: MeshProvider,
  endpointId: Identifier,
  source: z.enum(["observed", "advertised"]),
  label: Label.optional(),
  observedAt: z.number().nonnegative(),
}).strict();
export type AdvertisedModel = z.infer<typeof AdvertisedModel>;

export const EndpointModelCatalog = z.object({
  endpointId: Identifier,
  observedAt: z.number().nonnegative(),
  stale: z.boolean().optional(),
  models: z.array(AdvertisedModel).max(64),
  reason: z.string().trim().min(1).max(240).optional(),
}).strict();
export type EndpointModelCatalog = z.infer<typeof EndpointModelCatalog>;

export const MeshSnapshot = z.object({
  type: z.literal("mesh.snapshot"),
  sessionId: Identifier,
  projectId: Identifier,
  project: Project,
  bindings: z.array(ProjectBindingSummary).max(64).optional(),
  peers: z.array(IntegrationPeer).max(64).optional(),
  skills: z.array(SharedSkill).max(64).optional(),
  incomplete: z.boolean().optional(),
  execution: ProjectExecutionPolicy.optional(),
  restrictions: ProjectRestrictionSet.optional(),
  environment: ProjectEnvironment.optional(),
  modelCatalog: z.array(EndpointModelCatalog).max(32).optional(),
  tasks: z.array(MeshTask).max(64),
  executions: z.array(ExecutionSessionLink).max(128),
  claims: z.array(ResourceClaim).max(128),
  dependencies: z.array(TaskDependency).max(128),
  events: z.array(MeshEvent).max(128),
  generatedAt: z.number().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId || value.project.projectId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
  const taskIds = new Set(value.tasks.map((task) => task.taskId));
  const skillNames = new Set(value.skills?.map((skill) => skill.name));
  if ((value.skills?.length ?? 0) !== skillNames.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "duplicate skill name" });
  }
  const bindingIds = new Set(value.bindings?.map((binding) => binding.bindingId));
  const bindingKeys = new Set(value.bindings?.map(
    (binding) => `${binding.endpointId}\0${binding.repositoryId}`,
  ));
  if (bindingIds.size !== (value.bindings?.length ?? 0)
    || bindingKeys.size !== (value.bindings?.length ?? 0)
    || value.bindings?.some((binding) => binding.projectId !== value.projectId)
    || value.peers?.some((peer) => peer.projectId !== value.projectId)
    || value.tasks.some((task) => task.projectId !== value.projectId)
    || value.executions.some((execution) => !taskIds.has(execution.taskId))
    || value.claims.some((claim) => claim.projectId !== value.projectId || !taskIds.has(claim.taskId))
    || value.dependencies.some((dependency) => !taskIds.has(dependency.taskId))
    || value.events.some((event) => event.projectId !== value.projectId || !taskIds.has(event.taskId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks"], message: "snapshot scope mismatch" });
  }
});
export type MeshSnapshot = z.infer<typeof MeshSnapshot>;
