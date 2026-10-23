import assert from "node:assert/strict";
import test from "node:test";
import { readProjectKnowledge, type KnowledgeReadDependencies } from "../read";
import { ProjectKnowledgePage } from "../../../../../../packages/protocol/messages/mesh/knowledge/refresh";
import type { MeshSnapshot } from "../../../../../../packages/protocol/schema";

const query = { type: "mesh.knowledge.query" as const, sessionId: "project",
  projectId: "project", requestId: "read" };
const memory = { projectId: "project", taskId: "task", recordId: "old", category: "decision" as const,
  content: "Explicit decision", source: "user_decision" as const, sourceRef: "input",
  visibility: "project" as const, recordedAt: 1, streamVersion: 1 };
const call = { event_id: "event", invocation_id: "call", project_id: "project", task_id: "task",
  execution_id: "execution", provider: "codex", native_call_id: "native", tool_name: "Read",
  phase: "requested" as const, source: "transcript" as const, occurred_at: 2 };
function fixture(): KnowledgeReadDependencies {
  return { snapshot: () => ({ projectId: "project" }) as MeshSnapshot,
    memory: async () => [memory], history: async () => ({ events: [{ sequence: 1, event: call }],
      next_sequence: 1, previous_sequence: 1, has_more: false, has_older: false }),
    endpointId: "computer", now: () => 4, timeoutMs: 10 };
}

test("a stuck source has a bounded deadline while the other source remains usable", async () => {
  const deps = fixture();
  deps.history = () => new Promise(() => {});
  const started = Date.now();
  const page = await readProjectKnowledge(query, deps);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(page?.invocationAvailability, "unavailable");
  assert.deepEqual(page?.knowledge, [memory]);
  assert.equal(page?.memoryAvailability, "ready");
});

test("correction tombstones travel with the latest complete fact", async () => {
  const deps = fixture();
  const revised = { ...memory, recordId: "new", content: "Revised decision",
    supersedesRecordId: "old", streamVersion: 2, recordedAt: 3 };
  deps.memory = async () => [memory, revised];
  const page = await readProjectKnowledge(query, deps);
  assert.deepEqual(page?.knowledge, [revised]);
  assert.deepEqual(page?.supersededKnowledgeRecordIds, ["old"]);
});

test("a large Unicode journal drops oldest whole facts to fit encrypted transport", async () => {
  const deps = fixture();
  const content = "知".repeat(4_096);
  deps.memory = async () => Array.from({ length: 40 }, (_, index) => ({ ...memory,
    recordId: `decision-${index}`, content, recordedAt: index + 3, streamVersion: index + 1 }));
  deps.history = async () => ({ events: Array.from({ length: 32 }, (_, index) => ({
    sequence: index + 1, event: { ...call, event_id: `event-${index}`, occurred_at: index + 1,
      resource: "知".repeat(512), worktree: "知".repeat(512), revision: "知".repeat(512) },
  })), next_sequence: 32, previous_sequence: 1, has_more: true, has_older: true });
  const page = await readProjectKnowledge(query, deps);
  assert.ok(page && Buffer.byteLength(JSON.stringify(page)) <= 128 * 1_024);
  assert.ok(page.knowledge.length > 0 && page.knowledge.length < 32);
  assert.ok(page.invocations.length < 32);
  assert.ok(page.knowledge.every(row => row.content === content));
  assert.equal(page.incomplete, true);
  assert.equal(page.knowledge[0]?.recordId, "decision-39");
});

test("invalid scope and private memory cannot enter the Project response", async () => {
  assert.equal(await readProjectKnowledge({ ...query, sessionId: "other" }, fixture()), undefined);
  const deps = fixture();
  deps.snapshot = () => ({ projectId: "other" }) as MeshSnapshot;
  assert.equal(await readProjectKnowledge(query, deps), undefined);
  deps.snapshot = fixture().snapshot;
  deps.memory = async () => [{ ...memory, visibility: "task" }];
  const page = await readProjectKnowledge(query, deps);
  assert.equal(page?.memoryAvailability, "unavailable");
  assert.equal(page?.invocationAvailability, "ready");
  assert.equal(ProjectKnowledgePage.safeParse({ ...page, sessionId: "other" }).success, false);
});
