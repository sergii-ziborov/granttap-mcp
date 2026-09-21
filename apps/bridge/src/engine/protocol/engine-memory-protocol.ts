export type KnowledgeSource = "agent_report" | "task_capsule" | "observed_invocation" | "user_decision";
export type KnowledgeVisibility = "task" | "project";

export type KnowledgeRecordInput = {
  project_id: string;
  task_id: string;
  record_id: string;
  category: "decision" | "attempt" | "result";
  content: string;
  source: KnowledgeSource;
  source_ref: string;
  visibility: KnowledgeVisibility;
  repository_id?: string | null;
  commit_sha?: string | null;
  recorded_at: number;
};

export type KnowledgeRecord = KnowledgeRecordInput & { stream_version: number };
export type KnowledgePage = {
  project_id: string;
  entries: KnowledgeRecord[];
  next_before_version?: number | null;
  incomplete: boolean;
};

export type MemoryEngineOperation =
  | { operation: "memory.record"; input: KnowledgeRecordInput }
  | { operation: "memory.history"; input: {
    project_id: string; task_id?: string | null; visibility?: KnowledgeVisibility | null;
    before_version?: number | null; limit?: number | null;
  } };
export type MemoryEngineResult =
  | { operation: "memory.recorded"; record_id: string; stream_version: number }
  | { operation: "memory.history"; page: KnowledgePage };

const sources = new Set<KnowledgeSource>([
  "agent_report", "task_capsule", "observed_invocation", "user_decision",
]);

export function parseMemoryResult(result: Record<string, unknown>, invalid: () => never): boolean {
  if (result.operation === "memory.recorded") {
    bounded(result.record_id, 128, invalid);
    integer(result.stream_version, invalid);
    return true;
  }
  if (result.operation !== "memory.history") return false;
  const page = object(result.page, invalid);
  bounded(page.project_id, 128, invalid);
  if (typeof page.incomplete !== "boolean" || !Array.isArray(page.entries)
    || page.entries.length > 128) invalid();
  if (page.next_before_version != null) integer(page.next_before_version, invalid);
  for (const raw of page.entries) {
    const entry = object(raw, invalid);
    for (const [key, max] of [
      ["project_id", 128], ["task_id", 128], ["record_id", 128],
      ["content", 4_096], ["source_ref", 256],
    ] as const) bounded(entry[key], max, invalid);
    if (entry.project_id !== page.project_id
      || !["decision", "attempt", "result"].includes(String(entry.category))
      || !sources.has(entry.source as KnowledgeSource)
      || !["task", "project"].includes(String(entry.visibility))) invalid();
    if (entry.repository_id != null) bounded(entry.repository_id, 512, invalid);
    if (entry.commit_sha != null && (typeof entry.commit_sha !== "string"
      || !/^[0-9a-f]{7,64}$/i.test(entry.commit_sha))) invalid();
    integer(entry.recorded_at, invalid);
    integer(entry.stream_version, invalid);
  }
  return true;
}

function object(value: unknown, invalid: () => never): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function bounded(value: unknown, max: number, invalid: () => never): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid();
}

function integer(value: unknown, invalid: () => never): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
}
