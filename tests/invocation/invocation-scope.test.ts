import assert from "node:assert/strict";
import test from "node:test";
import { scopedInvocationSlice } from "../../apps/bridge/src/engine/invocation/scope";

const scope = { projectId: "project", taskId: "task" };

test("scoped Mesh resource only exposes this Task's content-free Engine events", async () => {
  const event = {
    event_id: "event", invocation_id: "call", project_id: "project", task_id: "task",
    execution_id: "execution", provider: "codex", native_call_id: "native",
    tool_name: "apply_patch", phase: "requested" as const,
    source: "transcript" as const, occurred_at: 1,
  };
  const client = { request: async () => ({
    operation: "invocation.history" as const,
    page: { events: [{ sequence: 1, event }], next_sequence: 1, previous_sequence: 1,
      has_more: false, has_older: false },
  }) };
  const slice = await scopedInvocationSlice(scope, { enabled: () => true, client: client as never });
  assert.equal(slice.availability, "ready");
  assert.equal(slice.events[0]?.event.task_id, "task");
  assert.equal(JSON.stringify(slice).includes("arguments"), false);
  const wrong = { request: async () => ({ ...await client.request(), page: {
    ...await client.request().then((value) => value.page),
    events: [{ sequence: 1, event: { ...event, task_id: "other" } }],
  } }) };
  assert.equal((await scopedInvocationSlice(scope, { enabled: () => true,
    client: wrong as never })).availability, "unavailable");
});

test("disabled Engine is explicit in the scoped resource", async () => {
  assert.deepEqual(await scopedInvocationSlice(scope, { enabled: () => false }), {
    availability: "unavailable", events: [], hasOlder: false,
  });
});
