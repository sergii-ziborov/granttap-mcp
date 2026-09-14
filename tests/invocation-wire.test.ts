import assert from "node:assert/strict";
import test from "node:test";
import { MeshInvocationPage, MeshInvocationQuery } from "../packages/protocol/schema";
import { invocationReply } from "../apps/bridge/src/engine/invocation-query";

const query = MeshInvocationQuery.parse({
  type: "mesh.invocation.query", sessionId: "project", projectId: "project",
  taskId: "task", requestId: "request", tail: true, limit: 16,
});

test("Invocation query and page stay under the Project key and Task scope", () => {
  const event = {
    event_id: "event", invocation_id: "invocation", project_id: "project",
    task_id: "task", execution_id: "execution", provider: "claude",
    native_call_id: "native", session_id: "session", tool_name: "Edit",
    phase: "reported_failure" as const, source: "transcript" as const,
    occurred_at: 1,
  };
  const reply = invocationReply(query, {
    events: [{ sequence: 4, event }], next_sequence: 4, previous_sequence: 4,
    has_more: false, has_older: true,
  }, "computer", 2);
  assert.equal(MeshInvocationPage.parse(reply).events[0]?.event.session_id, "session");
  assert.equal(MeshInvocationPage.safeParse({ ...reply, sessionId: "task" }).success, false);
  assert.equal(MeshInvocationPage.safeParse({
    ...reply, events: [{ sequence: 4, event: { ...event, task_id: "other" } }],
  }).success, false);
  assert.equal(MeshInvocationQuery.safeParse({ ...query, afterSequence: 1 }).success, false);
});

test("Unavailable Engine is explicit rather than a fabricated empty history", () => {
  const reply = MeshInvocationPage.parse(invocationReply(query, undefined, "computer", 2));
  assert.equal(reply.availability, "unavailable");
  assert.deepEqual(reply.events, []);
});
