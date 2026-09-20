/** The Engine's content-free, durable per-call evidence wire contract. */
export type InvocationPhase =
  | "requested" | "reported_success" | "reported_failure" | "reported_unknown"
  | "denied" | "change_observed" | "source_gap";
export type InvocationSource = "transcript" | "hook" | "filesystem" | "scanner";

export type InvocationEvent = {
  event_id: string;
  invocation_id: string;
  project_id: string;
  task_id: string;
  execution_id: string;
  provider: string;
  native_call_id: string;
  session_id?: string | null;
  tool_name: string;
  phase: InvocationPhase;
  source: InvocationSource;
  occurred_at: number;
  repository_id?: string | null;
  worktree?: string | null;
  resource?: string | null;
  revision?: string | null;
  content_hash?: string | null;
  capability_artifact_hash?: string | null;
  policy_revision?: number | null;
  policy_rule_id?: string | null;
};

export type InvocationHistoryQuery = {
  project_id: string;
  task_id?: string | null;
  after_sequence?: number | null;
  limit?: number | null;
  tail?: boolean;
  before_sequence?: number | null;
};

export type SequencedInvocationEvent = { sequence: number; event: InvocationEvent };
export type InvocationHistoryPage = {
  events: SequencedInvocationEvent[];
  next_sequence: number;
  has_more: boolean;
  previous_sequence: number;
  has_older: boolean;
};

export type InvocationEngineOperation =
  | { operation: "invocation.observe"; input: InvocationEvent }
  | { operation: "invocation.history"; input: InvocationHistoryQuery };
export type InvocationEngineResult =
  | { operation: "invocation.observed"; sequence: number }
  | { operation: "invocation.history"; page: InvocationHistoryPage };

const phases = new Set<InvocationPhase>([
  "requested", "reported_success", "reported_failure", "reported_unknown",
  "denied", "change_observed", "source_gap",
]);
const sources = new Set<InvocationSource>(["transcript", "hook", "filesystem", "scanner"]);

export function parseInvocationResult(result: Record<string, unknown>, invalid: () => never): boolean {
  if (result.operation === "invocation.observed") {
    if (!positiveInteger(result.sequence)) invalid();
    return true;
  }
  if (result.operation !== "invocation.history") return false;
  const page = record(result.page, invalid);
  if (!Array.isArray(page.events) || page.events.length > 32
    || !safeInteger(page.next_sequence) || typeof page.has_more !== "boolean"
    || !safeInteger(page.previous_sequence) || typeof page.has_older !== "boolean") invalid();
  let prior = 0;
  for (const raw of page.events as unknown[]) {
    const row = record(raw, invalid);
    if (!positiveInteger(row.sequence) || row.sequence <= prior || row.sequence > page.next_sequence) invalid();
    prior = row.sequence;
    parseInvocationEvent(row.event, invalid);
  }
  return true;
}

function parseInvocationEvent(value: unknown, invalid: () => never): void {
  const event = record(value, invalid);
  for (const [key, max] of [
    ["event_id", 128], ["invocation_id", 128], ["project_id", 128], ["task_id", 128],
    ["execution_id", 128], ["provider", 32], ["native_call_id", 128], ["tool_name", 160],
  ] as const) boundedString(event[key], max, invalid);
  if (!phases.has(event.phase as InvocationPhase) || !sources.has(event.source as InvocationSource)
    || !safeInteger(event.occurred_at)) invalid();
  for (const key of ["repository_id", "worktree", "resource", "revision"] as const) {
    if (event[key] != null) boundedString(event[key], 512, invalid);
  }
  if (event.session_id != null) boundedString(event.session_id, 128, invalid);
  for (const key of ["content_hash", "capability_artifact_hash"] as const) {
    if (event[key] != null && (typeof event[key] !== "string" || !/^[a-f0-9]{64}$/i.test(event[key]))) invalid();
  }
  if (event.policy_revision != null && !safeInteger(event.policy_revision)) invalid();
  if (event.policy_rule_id != null) boundedString(event.policy_rule_id, 128, invalid);
  if (event.phase === "change_observed" && (event.source !== "filesystem"
    || !event.repository_id || !event.resource || !event.revision || !event.content_hash)) invalid();
}

function record(value: unknown, invalid: () => never): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function boundedString(value: unknown, max: number, invalid: () => never): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\u0000-\u001f]/.test(value)) invalid();
}
