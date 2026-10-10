import assert from "node:assert/strict";
import test from "node:test";
import { recordsFromEvent } from "../../../apps/bridge/src/engine/runtime/engine-memory";
import type { MeshEvent } from "../../../packages/protocol/schema";

const base: MeshEvent = { type: "mesh.event", sessionId: "task", eventId: "failure",
  projectId: "project", taskId: "task", sourceSessionId: "native",
  eventType: "TASK_PROGRESS", createdAt: 10,
  payload: { failed: true, reason: "Compiler rejected the schema", summary: "Unsuccessful run" } };

test("failed progress becomes scoped attempt memory, never a successful result", () => {
  const values = recordsFromEvent(base);
  assert.equal(values[0]?.category, "attempt");
  assert.equal(values[0]?.content, base.payload.reason);
  assert.equal(values[0]?.visibility, "task");
  assert.equal(values[0]?.source_ref, "failure");
  assert.equal(recordsFromEvent({ ...base, payload: { summary: "Working" } }).length, 0);
});

test("failed completion stays an attempt and retains explicit Project visibility", () => {
  const values = recordsFromEvent({ ...base, eventType: "TASK_COMPLETED" });
  assert.equal(values[0]?.category, "attempt");
  assert.equal(values[0]?.visibility, "project");
  assert.equal(recordsFromEvent({ ...base, payload: { failed: true } }).length, 0);
});
