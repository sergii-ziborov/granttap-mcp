import { parseInvocationResult } from "../engine-invocation-protocol";
import { parseMemoryResult } from "../engine-memory-protocol";
import { parsePolicyResult } from "../engine-policy-protocol";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineProtocolError,
  EngineRemoteError,
} from "./protocol-base";
import type {
  EngineContextCompilation,
  EngineResult,
  EngineWireObject,
  ProjectBindingRole,
} from "./protocol-types";

export function parseEngineResponse(value: unknown, requestId: string): EngineResult {
  const response = requireObject(value, "engine response");
  if (response.protocol_version !== ENGINE_PROTOCOL_VERSION) {
    throw new EngineProtocolError("engine protocol version mismatch");
  }
  if (response.request_id !== requestId) {
    throw new EngineProtocolError("engine response request_id mismatch");
  }
  if (response.status === "error") {
    const error = requireObject(response.error, "engine error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new EngineProtocolError("engine error payload is invalid");
    }
    throw new EngineRemoteError(error.code, error.message);
  }
  if (response.status !== "ok") {
    throw new EngineProtocolError("engine response status is invalid");
  }
  return parseResult(response.result);
}

function parseResult(value: unknown): EngineResult {
  const result = requireObject(value, "engine result");
  const operation = result.operation;
  if (operation === "engine.pong") parsePong(result);
  else if (operation === "engine.version") parseVersion(result);
  else if (operation === "project.resolved") parseResolution(result.resolution);
  else if (operation === "project.found") parseProject(result.project);
  else if (operation === "project.bindings") parseBindings(result.bindings);
  else if (operation === "project.binding_upserted") parseBinding(result.binding);
  else if (operation === "graph.backbone") parseBackbone(result.backbone);
  else if (operation === "graph.repository") parseRepositoryGraph(result.graph);
  else if (operation === "context.compiled") {
    return { operation, compilation: parseContextCompilation(result.compilation) };
  }
  else if (!parseMemoryResult(result, invalidResult)
    && !parsePolicyResult(result, invalidResult)
    && !parseInvocationResult(result, invalidResult)) {
    throw new EngineProtocolError("engine result operation is unsupported");
  }
  return result as EngineResult;
}

function parsePong(result: EngineWireObject): void {
  requireString(result.engine_version, "engine_version");
}

function parseVersion(result: EngineWireObject): void {
  requireString(result.engine_version, "engine_version");
  if (result.protocol_version !== ENGINE_PROTOCOL_VERSION) {
    throw new EngineProtocolError("engine result protocol version mismatch");
  }
  requireBoundedString(result.cortex_version, "Cortex version", 64);
  requireBoundedString(result.cortex_revision, "Cortex revision", 64);
  requireBoundedString(result.weavatrix_version, "Weavatrix version", 64);
}

function parseResolution(value: unknown): void {
  const resolution = requireObject(value, "project resolution");
  requireString(resolution.project_id, "project_id");
  if (typeof resolution.compatibility_mode !== "boolean") invalidResult();
}

function parseBindings(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalidResult();
  value.forEach(parseBinding);
}

function parseContextCompilation(value: unknown): EngineContextCompilation {
  const compilation = requireObject(value, "context compilation");
  requireBoundedString(compilation.project_id, "project_id", 128);
  requireBoundedString(compilation.task_id, "task_id", 128);
  requireBoundedString(compilation.cortex_version, "Cortex version", 64);
  requireBoundedString(compilation.cortex_revision, "Cortex revision", 64);
  const wirePacket = requireObject(compilation.packet, "context packet");
  const packet: EngineWireObject = { ...wirePacket };
  const aliases = [
    ["includedIds", "included_ids"], ["omittedIds", "omitted_ids"],
    ["rawEstimatedTokens", "raw_estimated_tokens"],
    ["selectedEstimatedTokens", "selected_estimated_tokens"],
    ["omittedEstimatedTokens", "omitted_estimated_tokens"],
    ["requiresUpstream", "requires_upstream"],
    ["deduplicatedLines", "deduplicated_lines"],
    ["deduplicatedEstimatedTokens", "deduplicated_estimated_tokens"],
    ["packetId", "packet_id"], ["snapshotId", "snapshot_id"],
  ] as const;
  for (const [libraryField, protocolField] of aliases) {
    if (!Object.hasOwn(wirePacket, libraryField)) continue;
    if (Object.hasOwn(wirePacket, protocolField)) invalidResult();
    packet[protocolField] = wirePacket[libraryField];
    delete packet[libraryField];
  }
  requireBoundedString(packet.content, "context packet content", 1_048_576);
  for (const field of ["included_ids", "omitted_ids"] as const) {
    if (!Array.isArray(packet[field]) || packet[field].length > 256
      || packet[field].some((item) => typeof item !== "string" || item.length > 160)) invalidResult();
  }
  for (const field of [
    "raw_estimated_tokens", "selected_estimated_tokens", "omitted_estimated_tokens",
    "deduplicated_lines", "deduplicated_estimated_tokens",
  ] as const) {
    if (!Number.isSafeInteger(packet[field]) || Number(packet[field]) < 0) invalidResult();
  }
  if (typeof packet.requires_upstream !== "boolean") invalidResult();
  requireOptionalString(packet.packet_id, "packet_id", 128);
  requireOptionalString(packet.snapshot_id, "snapshot_id", 512);
  return { ...compilation, packet } as EngineContextCompilation;
}

function parseRepositoryGraph(value: unknown): void {
  const graph = requireObject(value, "repository graph");
  requireBoundedString(graph.project_id, "project_id", 128);
  requireBoundedString(graph.repository_id, "repository_id", 512);
  requireBoundedString(graph.revision, "graph revision", 512);
  requireBoundedString(graph.weavatrix_version, "Weavatrix version", 64);
  requireOptionalString(graph.analysis_id, "analysis_id", 128);
  if (graph.analysis_status != null && graph.analysis_status !== "COMPLETE"
    && graph.analysis_status !== "INCOMPLETE") invalidResult();
  if (graph.architecture_hypotheses != null) {
    if (!Array.isArray(graph.architecture_hypotheses)
      || graph.architecture_hypotheses.length > 8) invalidResult();
    for (const value of graph.architecture_hypotheses) {
      const item = requireObject(value, "architecture hypothesis");
      requireBoundedString(item.name, "architecture name", 64);
      requireBoundedString(item.dimension, "architecture dimension", 64);
      if (!["SUPPORTED", "CANDIDATE", "CONTRADICTED", "INSUFFICIENT_EVIDENCE"]
        .includes(String(item.status))) invalidResult();
      for (const [key, count, length] of [
        ["evidence", 16, 240], ["contradictions", 16, 240], ["unknowns", 4, 160],
      ] as const) {
        if (!Array.isArray(item[key]) || item[key].length > count) invalidResult();
        for (const text of item[key]) requireBoundedString(text, key, length);
      }
    }
  }
  if (graph.code_map != null) parseCodeMap(graph.code_map);
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 256
    || !Array.isArray(graph.relations) || graph.relations.length > 512
    || !Number.isSafeInteger(graph.total_nodes) || Number(graph.total_nodes) < 0
    || !Number.isSafeInteger(graph.total_relations) || Number(graph.total_relations) < 0
    || typeof graph.truncated !== "boolean") invalidResult();
  for (const value of graph.nodes) {
    const node = requireObject(value, "repository graph node");
    requireBoundedString(node.id, "graph node id", 512);
    requireBoundedString(node.kind, "graph node kind", 64);
    requireBoundedString(node.label, "graph node label", 160);
  }
  for (const value of graph.relations) {
    const relation = requireObject(value, "repository graph relation");
    requireBoundedString(relation.source, "graph relation source", 512);
    requireBoundedString(relation.target, "graph relation target", 512);
    requireBoundedString(relation.relation, "graph relation kind", 64);
    if (relation.evidence_count != null
      && (!Number.isSafeInteger(relation.evidence_count)
        || Number(relation.evidence_count) < 0)) invalidResult();
  }
}

function parseCodeMap(value: unknown): void {
  const map = requireObject(value, "repository code map");
  if (!Array.isArray(map.files) || map.files.length > 650
    || (map.externals != null && (!Array.isArray(map.externals) || map.externals.length > 24))
    || !Array.isArray(map.roads) || map.roads.length > 1_200
    || !Number.isSafeInteger(map.total_files) || Number(map.total_files) < map.files.length
    || (map.total_externals != null && !Number.isSafeInteger(map.total_externals))
    || Number(map.total_externals ?? 0) < (Array.isArray(map.externals) ? map.externals.length : 0)
    || typeof map.truncated !== "boolean") invalidResult();
  const paths = new Set<string>();
  for (const value of map.files) {
    const file = requireObject(value, "repository code file");
    requireBoundedString(file.path, "code path", 512);
    const path = file.path as string;
    if (path.startsWith("/") || path.split("/").includes("..") || paths.has(path)) invalidResult();
    paths.add(path);
    requireOptionalString(file.language, "code language", 64);
    if (file.line_count != null
      && (!Number.isSafeInteger(file.line_count) || Number(file.line_count) < 1)) invalidResult();
    if (!Array.isArray(file.symbols) || file.symbols.length > 72) invalidResult();
    for (const value of file.symbols) {
      const symbol = requireObject(value, "code symbol");
      requireBoundedString(symbol.id, "code symbol id", 512);
      requireBoundedString(symbol.label, "code symbol label", 160);
      requireBoundedString(symbol.kind, "code symbol kind", 64);
      if (!Number.isSafeInteger(symbol.start_line) || Number(symbol.start_line) < 1
        || !Number.isSafeInteger(symbol.line_count) || Number(symbol.line_count) < 1) invalidResult();
    }
  }
  for (const value of (map.externals ?? []) as unknown[]) {
    const external = requireObject(value, "repository external resource");
    requireBoundedString(external.id, "external id", 512);
    requireBoundedString(external.label, "external label", 160);
    requireBoundedString(external.kind, "external kind", 64);
    const id = external.id as string;
    if (!id.startsWith("ext:") || id.length < 5 || paths.has(id)) invalidResult();
    paths.add(id);
  }
  for (const value of map.roads) {
    const road = requireObject(value, "code road");
    requireBoundedString(road.source, "road source", 512);
    requireBoundedString(road.target, "road target", 512);
    const source = road.source as string;
    const target = road.target as string;
    requireBoundedString(road.relation, "road relation", 64);
    if (!paths.has(source) || !paths.has(target)) invalidResult();
  }
}

function parseBackbone(value: unknown): void {
  const backbone = requireObject(value, "project backbone");
  requireBoundedString(backbone.project_id, "project_id", 128);
  if (backbone.head != null) requireBoundedString(backbone.head, "backbone head", 128);
  if (!Array.isArray(backbone.nodes) || backbone.nodes.length > 512
    || !Array.isArray(backbone.relations) || backbone.relations.length > 1_024
    || !Number.isSafeInteger(backbone.pending_candidate_count)
    || Number(backbone.pending_candidate_count) < 0) invalidResult();
  for (const value of backbone.nodes) {
    const node = requireObject(value, "backbone node");
    requireBoundedString(node.kind, "node kind", 64);
    requireBoundedString(node.identity, "node identity", 512);
    requireBoundedString(node.display_name, "node display name", 160);
  }
  for (const value of backbone.relations) {
    const relation = requireObject(value, "backbone relation");
    requireBoundedString(relation.source, "relation source", 512);
    requireBoundedString(relation.target, "relation target", 512);
    requireBoundedString(relation.relation, "relation kind", 64);
    if (!Number.isSafeInteger(relation.evidence_count)
      || Number(relation.evidence_count) < 0) invalidResult();
  }
}

function parseProject(value: unknown): void {
  const project = requireObject(value, "Project");
  requireBoundedString(project.project_id, "project_id", 128);
  requireBoundedString(project.name, "project name", 160);
  requireTimestamp(project.created_at);
}

function parseBinding(value: unknown): void {
  const binding = requireObject(value, "Project binding");
  requireBoundedString(binding.binding_id, "binding_id", 128);
  requireBoundedString(binding.project_id, "project_id", 128);
  requireBoundedString(binding.endpoint_id, "endpoint_id", 128);
  requireBoundedString(binding.repository_id, "repository_id", 512);
  requireOptionalString(binding.local_root, "local_root", 4_096);
  requireOptionalString(binding.local_alias, "local_alias", 160);
  requireOptionalString(binding.canonical_remote, "canonical_remote", 1_024);
  requireOptionalString(binding.observed_revision, "observed_revision", 512);
  if (!isBindingRole(binding.role)) invalidResult();
  requireTimestamp(binding.last_seen_at);
}

function requireObject(value: unknown, label: string): EngineWireObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineProtocolError(`${label} must be an object`);
  }
  return value as EngineWireObject;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EngineProtocolError(`engine ${field} is invalid`);
  }
}

function requireBoundedString(value: unknown, field: string, maximum: number): void {
  requireString(value, field);
  if (value.length > maximum) invalidResult();
}

function requireOptionalString(value: unknown, field: string, maximum: number): void {
  if (value != null) requireBoundedString(value, field, maximum);
}

function requireTimestamp(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidResult();
}

function isBindingRole(value: unknown): value is ProjectBindingRole {
  return value === "primary" || value === "dependency" || value === "supporting";
}

function invalidResult(): never {
  throw new EngineProtocolError("engine result payload is invalid");
}
