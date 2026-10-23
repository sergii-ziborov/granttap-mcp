import assert from "node:assert/strict";
import test from "node:test";
import { readProjectKnowledge, type KnowledgeReadDependencies } from "../read";
import { ProjectKnowledgePage, ProjectKnowledgeQuery } from "../../../../../../packages/protocol/messages/mesh/knowledge/refresh";

const query = { type: "mesh.knowledge.query" as const, sessionId: "project",
  projectId: "project", requestId: "request" };
const memory = { projectId: "project", taskId: "older-task", recordId: "decision",
  category: "decision" as const, content: "Keep this explicit decision",
  source: "user_decision" as const, sourceRef: "request", visibility: "project" as const,
  recordedAt: 20, streamVersion: 1 };
const call = { event_id: "event", invocation_id: "call", project_id: "project",
  task_id: "older-task", execution_id: "execution", provider: "codex", native_call_id: "native",
  tool_name: "read_file", phase: "reported_success" as const, source: "transcript" as const,
  occurred_at: 30 };
function fixture(): KnowledgeReadDependencies {
  return {
    snapshot: () => ({ type: "mesh.snapshot", sessionId: "project", projectId: "project",
      project: { projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: 1 },
      tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: 1 }),
    memory: async () => [memory],
    history: async () => ({ events: [{ sequence: 1, event: call }], next_sequence: 1,
      previous_sequence: 1, has_more: false, has_older: true }),
    endpointId: "computer", now: () => 40,
  };
}

test("a Project read returns durable knowledge and recent calls, including older Tasks outside the snapshot window", async () => {
  const page = await readProjectKnowledge(query, fixture());
  assert.ok(page);
  assert.equal(ProjectKnowledgePage.safeParse(page).success, true);
  assert.deepEqual(page.knowledge, [memory]);
  assert.equal(page.invocations[0]?.event.task_id, "older-task");
  assert.equal(page.generatedAt, 40);
  assert.equal(page.incomplete, true);
});

test("an unavailable source preserves the other source instead of blocking the Project", async () => {
  const deps = fixture();
  deps.memory = async () => { throw new Error("Engine memory temporarily unavailable"); };
  const page = await readProjectKnowledge(query, deps);
  assert.equal(page?.memoryAvailability, "unavailable");
  assert.equal(page?.invocationAvailability, "ready");
  assert.equal(page?.invocations.length, 1);
});

test("unknown Projects never issue journal reads, and cross-Project data is rejected", async () => {
  const deps = fixture();
  deps.snapshot = () => undefined;
  deps.memory = async () => { assert.fail("unknown Project must not read Memory"); };
  deps.history = async () => { assert.fail("unknown Project must not read calls"); };
  assert.equal(await readProjectKnowledge(query, deps), undefined);
  assert.equal(ProjectKnowledgeQuery.safeParse({ ...query, sessionId: "other" }).success, false);
  const other = fixture();
  other.history = async () => ({ events: [{ sequence: 1, event: { ...call, project_id: "other" } }],
    next_sequence: 1, previous_sequence: 1, has_more: false, has_older: false });
  const page = await readProjectKnowledge(query, other);
  assert.equal(page?.invocationAvailability, "unavailable");
  assert.deepEqual(page?.invocations, []);
});
