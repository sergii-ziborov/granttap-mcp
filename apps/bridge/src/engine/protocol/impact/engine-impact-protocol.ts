import { EngineProtocolError } from "../transport/protocol-base";

export type EngineGraphHeads = {
  project_id: string;
  project_backbone_head: string | null;
  task_graph_heads: Array<{ task_id: string; head: string }>;
  repo_revisions: Array<{ repository_id: string; revision: string }>;
};

export type EngineGraphImpact = {
  task_graph_head: string;
  completeness: "complete" | "partial";
  affected_roots: string[];
  repositories: string[];
  files: string[];
  related_files: string[];
  unresolved: string[];
};

export type EngineImpactOperation =
  | { operation: "graph.get_heads"; input: { project_id: string; task_id: string } }
  | { operation: "graph.compute_impact"; input: {
    project_id: string; task_id: string; repository_id: string;
    paths: string[]; max_results: number;
  } };

export type EngineImpactResult =
  | { operation: "graph.heads"; heads: EngineGraphHeads }
  | { operation: "graph.impact"; impact: EngineGraphImpact };

export function parseImpactResult(value: Record<string, unknown>): boolean {
  if (value.operation === "graph.heads") {
    const heads = object(value.heads);
    bounded(heads.project_id, 128);
    if (heads.project_backbone_head != null) bounded(heads.project_backbone_head, 128);
    rows(heads.task_graph_heads, 256, (row) => {
      bounded(row.task_id, 128);
      bounded(row.head, 128);
    });
    rows(heads.repo_revisions, 256, (row) => {
      bounded(row.repository_id, 512);
      bounded(row.revision, 512);
    });
    return true;
  }
  if (value.operation === "graph.impact") {
    const impact = object(value.impact);
    bounded(impact.task_graph_head, 128);
    if (impact.completeness !== "complete" && impact.completeness !== "partial") invalid();
    for (const name of ["affected_roots", "repositories", "files", "related_files", "unresolved"]) {
      const entries = impact[name];
      if (!Array.isArray(entries) || entries.length > 256) invalid();
      for (const entry of entries) bounded(entry, 512);
    }
    return true;
  }
  return false;
}

function rows(value: unknown, max: number, validate: (row: Record<string, unknown>) => void): void {
  if (!Array.isArray(value) || value.length > max) invalid();
  for (const entry of value) validate(object(entry));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function bounded(value: unknown, max: number): void {
  if (typeof value !== "string" || !value || value.length > max) invalid();
}

function invalid(): never { throw new EngineProtocolError("engine graph result is invalid"); }
