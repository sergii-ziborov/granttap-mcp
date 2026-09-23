import { z } from "zod";
import { ProjectCodeMap } from "./graph/code-map";
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
import { ProjectKnowledgeRecord } from "./knowledge";

export const IntegrationVia = z.enum(["database", "kafka", "api"]);
export type IntegrationVia = z.infer<typeof IntegrationVia>;
export const IntegrationRelation = z.enum(["produces", "consumes", "calls", "called_by", "shares"]);
export type IntegrationRelation = z.infer<typeof IntegrationRelation>;

/**
 * Legacy compatibility edge. The verified Rust Engine Backbone is the
 * authoritative topology whenever it is available.
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

/** One MCP server actually advertised by a Project execution. */
export const ProjectMcpServer = z.object({
  name: Label,
  title: Label.optional(),
  provider: MeshProvider,
  endpointId: Identifier,
  configuredEnabled: z.boolean(),
  allowed: z.boolean(),
  authStatus: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().min(1).max(80).optional(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  metadataSource: z.literal("mcp").optional(),
  // Empty means native configuration was observed without an open execution.
  sessionIds: z.array(Identifier).max(64),
}).strict();
export type ProjectMcpServer = z.infer<typeof ProjectMcpServer>;

export const ProjectCapabilityRequest = z.object({
  projectId: Identifier,
  requestId: Identifier.optional(),
  kind: z.enum(["skill", "mcp"]),
  name: Label,
  source: z.string().trim().min(1).max(512).optional(),
  version: z.string().trim().min(1).max(128).optional(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  targetEndpointId: Identifier.optional(),
  requestedAt: z.number().nonnegative(),
}).strict();
export type ProjectCapabilityRequest = z.infer<typeof ProjectCapabilityRequest>;

export const ProjectCapabilityRequestSet = ProjectCapabilityRequest.extend({
  type: z.literal("project.capability.request"),
  sessionId: Identifier,
  requestId: Identifier,
}).strict().superRefine((value, ctx) => {
  if (value.sessionId !== value.projectId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionId"], message: "project scope mismatch" });
  }
});
export type ProjectCapabilityRequestSet = z.infer<typeof ProjectCapabilityRequestSet>;

export const ProjectCapabilityObservation = z.object({
  projectId: Identifier,
  requestId: Identifier,
  endpointId: Identifier,
  state: z.enum([
    "needs_binding", "not_found", "discovered", "configured", "initialized",
    "credential_missing", "version_conflict", "unsupported",
  ]),
  version: z.string().trim().min(1).max(128).optional(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  observedAt: z.number().nonnegative(),
}).strict();
export type ProjectCapabilityObservation = z.infer<typeof ProjectCapabilityObservation>;

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

export const ProjectBackbone = z.object({
  projectId: Identifier,
  head: z.string().trim().min(1).max(128).optional(),
  nodes: z.array(z.object({
    kind: z.string().trim().min(1).max(64),
    identity: z.string().trim().min(1).max(512),
    displayName: Label,
  }).strict()).max(512),
  relations: z.array(z.object({
    source: z.string().trim().min(1).max(512),
    target: z.string().trim().min(1).max(512),
    relation: z.string().trim().min(1).max(64),
    evidenceCount: z.number().int().nonnegative(),
  }).strict()).max(1_024),
  pendingCandidateCount: z.number().int().nonnegative(),
}).strict();
export type ProjectBackbone = z.infer<typeof ProjectBackbone>;

export const ProjectRepositoryGraph = z.object({
  projectId: Identifier,
  repositoryId: z.string().trim().min(1).max(512),
  revision: z.string().trim().min(1).max(512),
  weavatrixVersion: z.string().trim().min(1).max(64),
  analysisId: z.string().trim().min(1).max(128).optional(),
  analysisStatus: z.enum(["COMPLETE", "INCOMPLETE", "UNAVAILABLE"]).optional(),
  analysisErrorCode: z.string().regex(/^[A-Z_]{2,64}$/).optional(),
  architectureHypotheses: z.array(z.object({
    name: z.string().trim().min(1).max(64),
    dimension: z.string().trim().min(1).max(64),
    status: z.enum(["SUPPORTED", "CANDIDATE", "CONTRADICTED", "INSUFFICIENT_EVIDENCE"]),
    evidence: z.array(z.string().max(240)).max(16),
    contradictions: z.array(z.string().max(240)).max(16),
    unknowns: z.array(z.string().max(160)).max(4),
  }).strict()).max(8).optional(),
  codeMap: ProjectCodeMap.optional(),
  nodes: z.array(z.object({
    id: z.string().trim().min(1).max(512),
    kind: z.string().trim().min(1).max(64),
    label: Label,
  }).strict()).max(256),
  relations: z.array(z.object({
    source: z.string().trim().min(1).max(512),
    target: z.string().trim().min(1).max(512),
    relation: z.string().trim().min(1).max(64),
    evidenceCount: z.number().int().nonnegative().optional(),
  }).strict()).max(512),
  totalNodes: z.number().int().nonnegative(),
  totalRelations: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.analysisStatus !== "UNAVAILABLE") return;
  if (!value.analysisErrorCode || value.nodes.length || value.relations.length
    || value.totalNodes || value.totalRelations) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["analysisStatus"],
      message: "unavailable graph cannot contain architecture evidence",
    });
  }
});
export type ProjectRepositoryGraph = z.infer<typeof ProjectRepositoryGraph>;

export const CortexPacketStatus = z.object({
  packetId: Identifier.optional(),
  snapshotId: z.string().trim().min(1).max(512).optional(),
  included: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  rawEstimatedTokens: z.number().int().nonnegative(),
  selectedEstimatedTokens: z.number().int().nonnegative(),
  omittedEstimatedTokens: z.number().int().nonnegative(),
  deduplicatedLines: z.number().int().nonnegative(),
  requiresUpstream: z.boolean(),
}).strict();
export type CortexPacketStatus = z.infer<typeof CortexPacketStatus>;

/** Cortex Loom is a native optional integration, never an MCP catalog entry. */
export const ProjectCortexIntegration = z.object({
  projectId: Identifier,
  endpointId: Identifier,
  enabled: z.boolean(),
  maxTokens: z.number().int().min(512).max(262_144),
  state: z.enum(["disabled", "loaded", "succeeded", "unavailable", "degraded"]),
  version: z.string().trim().min(1).max(64).optional(),
  revision: z.string().trim().min(1).max(64).optional(),
  weavatrixVersion: z.string().trim().min(1).max(64).optional(),
  packet: CortexPacketStatus.optional(),
  detail: z.string().trim().min(1).max(240).optional(),
  checkedAt: z.number().nonnegative(),
}).strict();
export type ProjectCortexIntegration = z.infer<typeof ProjectCortexIntegration>;

export const MeshSnapshot = z.object({
  type: z.literal("mesh.snapshot"),
  sessionId: Identifier,
  projectId: Identifier,
  publisherEndpointId: Identifier.optional(),
  project: Project,
  bindings: z.array(ProjectBindingSummary).max(64).optional(),
  peers: z.array(IntegrationPeer).max(64).optional(),
  skills: z.array(SharedSkill).max(64).optional(),
  mcpServers: z.array(ProjectMcpServer).max(128).optional(),
  capabilityRequests: z.array(ProjectCapabilityRequest).max(128).optional(),
  capabilityObservations: z.array(ProjectCapabilityObservation).max(128).optional(),
  incomplete: z.boolean().optional(),
  execution: ProjectExecutionPolicy.optional(),
  restrictions: ProjectRestrictionSet.optional(),
  environment: ProjectEnvironment.optional(),
  modelCatalog: z.array(EndpointModelCatalog).max(32).optional(),
  backbone: ProjectBackbone.optional(),
  repositoryGraphs: z.array(ProjectRepositoryGraph).max(64).optional(),
  cortex: z.array(ProjectCortexIntegration).max(32).optional(),
  knowledge: z.array(ProjectKnowledgeRecord).max(32).optional(),
  supersededKnowledgeRecordIds: z.array(Identifier).max(128).optional(),
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
  if (value.publisherEndpointId && (
    value.skills?.some((item) => item.endpointId !== value.publisherEndpointId)
    || value.mcpServers?.some((item) => item.endpointId !== value.publisherEndpointId)
    || value.capabilityObservations?.some((item) => item.endpointId !== value.publisherEndpointId)
  )) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publisherEndpointId"], message: "inventory publisher mismatch" });
  }
  const taskIds = new Set(value.tasks.map((task) => task.taskId));
  const skillNames = new Set(value.skills?.map((skill) => `${skill.endpointId ?? ""}\0${skill.name}`));
  if ((value.skills?.length ?? 0) !== skillNames.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "duplicate skill name" });
  }
  const mcpKeys = new Set(value.mcpServers?.map(
    (server) => JSON.stringify([
      server.endpointId, server.provider, server.name,
      server.version ?? null, server.authStatus ?? null,
    ]),
  ));
  if ((value.mcpServers?.length ?? 0) !== mcpKeys.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mcpServers"], message: "duplicate MCP server" });
  }
  const requestKeys = new Set(value.capabilityRequests?.map(
    (item) => `${item.kind}\0${item.name.toLowerCase()}\0${item.targetEndpointId ?? ""}`,
  ));
  if ((value.capabilityRequests?.length ?? 0) !== requestKeys.size
    || value.capabilityRequests?.some((item) => item.projectId !== value.projectId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityRequests"], message: "invalid capability request scope" });
  }
  const observations = value.capabilityObservations ?? [];
  const observationKeys = new Set(observations.map((item) =>
    `${item.requestId}\0${item.endpointId}`));
  if (observationKeys.size !== observations.length
    || observations.some((item) => item.projectId !== value.projectId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityObservations"], message: "invalid capability observation scope" });
  }
  const cortexEndpoints = new Set(value.cortex?.map((item) => item.endpointId));
  if ((value.cortex?.length ?? 0) !== cortexEndpoints.size
    || value.cortex?.some((item) => item.projectId !== value.projectId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cortex"], message: "invalid Cortex scope" });
  }
  const graphRepositories = new Set(value.repositoryGraphs?.map((item) => item.repositoryId));
  if ((value.repositoryGraphs?.length ?? 0) !== graphRepositories.size
    || value.repositoryGraphs?.some((item) => item.projectId !== value.projectId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repositoryGraphs"], message: "invalid repository graph scope" });
  }
  const knowledgeIds = new Set(value.knowledge?.map((item) => item.recordId));
  const supersededKnowledgeIds = new Set(value.supersededKnowledgeRecordIds);
  if (supersededKnowledgeIds.size !== (value.supersededKnowledgeRecordIds?.length ?? 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supersededKnowledgeRecordIds"],
      message: "duplicate superseded knowledge identity" });
  }
  if ((value.knowledge?.length ?? 0) !== knowledgeIds.size
    || value.knowledge?.some((item) => item.projectId !== value.projectId
      || item.visibility !== "project")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["knowledge"], message: "invalid knowledge scope" });
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
