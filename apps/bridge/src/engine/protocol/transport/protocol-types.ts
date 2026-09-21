import type {
  EnginePolicyOperation,
  EnginePolicyResult,
} from "../engine-policy-protocol";
import type {
  InvocationEngineOperation,
  InvocationEngineResult,
} from "../engine-invocation-protocol";
import { ENGINE_PROTOCOL_VERSION } from "./protocol-base";

export type ProjectBindingRole = "primary" | "dependency" | "supporting";
export type EngineProject = { project_id: string; name: string; created_at: number };

export type EngineProjectBinding = {
  binding_id: string;
  project_id: string;
  endpoint_id: string;
  repository_id: string;
  local_root?: string | null;
  local_alias?: string | null;
  canonical_remote?: string | null;
  role: ProjectBindingRole;
  observed_revision?: string | null;
  last_seen_at: number;
};

export type EngineProjectBackbone = {
  project_id: string;
  head?: string | null;
  nodes: Array<{ kind: string; identity: string; display_name: string }>;
  relations: Array<{ source: string; target: string; relation: string; evidence_count: number }>;
  pending_candidate_count: number;
};

export type EngineRepositoryGraph = {
  project_id: string;
  repository_id: string;
  revision: string;
  weavatrix_version: string;
  nodes: Array<{ id: string; kind: string; label: string }>;
  relations: Array<{ source: string; target: string; relation: string }>;
  total_nodes: number;
  total_relations: number;
  truncated: boolean;
};

export type EngineContextEvidence = {
  id: string;
  source: string;
  content: string;
  priority: "critical" | "high" | "normal" | "low";
  state: "verified" | "unverified" | "contradictory";
  derivation: "exact_source" | "plan" | "graph" | "search" | "memory" | "inferred";
  snapshot_id?: string | null;
};

export type EngineContextCompilation = {
  project_id: string;
  task_id: string;
  cortex_version: string;
  cortex_revision: string;
  packet: {
    content: string;
    included_ids: string[];
    omitted_ids: string[];
    raw_estimated_tokens: number;
    selected_estimated_tokens: number;
    omitted_estimated_tokens: number;
    requires_upstream: boolean;
    deduplicated_lines: number;
    deduplicated_estimated_tokens: number;
    packet_id?: string | null;
    snapshot_id?: string | null;
  };
};

export type EngineOperation = EnginePolicyOperation | InvocationEngineOperation
  | { operation: "engine.ping" }
  | { operation: "engine.version" }
  | { operation: "project.resolve"; input: {
    project_id?: string; endpoint_id?: string; repository_id?: string; local_root?: string;
  } }
  | { operation: "project.get"; input: { project_id: string } }
  | { operation: "project.list_bindings"; input: { project_id: string } }
  | { operation: "graph.get_backbone"; input: { project_id: string } }
  | { operation: "graph.analyze_repository"; input: {
    project_id: string; repository_id: string;
  } }
  | { operation: "context.compile_project"; input: {
    project_id: string; task_id: string; max_tokens: number; evidence: EngineContextEvidence[];
  } }
  | { operation: "project.upsert_binding"; input: {
    project: EngineProject; binding: EngineProjectBinding;
  } };

export type EngineRequest = {
  protocol_version: typeof ENGINE_PROTOCOL_VERSION;
  request_id: string;
} & EngineOperation;

export type EngineResult = EnginePolicyResult | InvocationEngineResult
  | { operation: "engine.pong"; engine_version: string }
  | { operation: "engine.version"; engine_version: string;
    protocol_version: typeof ENGINE_PROTOCOL_VERSION; cortex_version: string;
    cortex_revision: string; weavatrix_version: string }
  | { operation: "project.resolved"; resolution: {
    project_id: string; compatibility_mode: boolean;
  } }
  | { operation: "project.found"; project: EngineProject }
  | { operation: "project.bindings"; bindings: EngineProjectBinding[] }
  | { operation: "graph.backbone"; backbone: EngineProjectBackbone }
  | { operation: "graph.repository"; graph: EngineRepositoryGraph }
  | { operation: "context.compiled"; compilation: EngineContextCompilation }
  | { operation: "project.binding_upserted"; binding: EngineProjectBinding };

export type EngineWireObject = Record<string, unknown>;
