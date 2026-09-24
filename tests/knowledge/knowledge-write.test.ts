import assert from "node:assert/strict";
import test from "node:test";
import { handleKnowledgeWrite } from "../../apps/bridge/src/mesh/knowledge/write";
import type { KnowledgeWrite, KnowledgeWriteResult } from "../../packages/protocol/schema";

const request: KnowledgeWrite = {
  type: "knowledge.write", projectId: "project-1", taskId: "task-1",
  recordId: "decision-1", content: "Use the verified repository path.",
  createdAt: 1_000_000,
};

test("an explicit decision is persisted under the existing Project and Task", async () => {
  const saved: unknown[] = [];
  const sent: KnowledgeWriteResult[] = [];
  const result = await handleKnowledgeWrite(request, {
    now: () => 1_000_001, endpointId: "host-1",
    snapshot: () => ({ tasks: [{ taskId: "task-1" }],
      bindings: [{ endpointId: "host-1" }] }),
    record: async (input) => { saved.push(input); return true; },
    send: async (reply) => { sent.push(reply); },
  });
  assert.equal(result, true);
  assert.deepEqual(saved, [{ project_id: "project-1", task_id: "task-1",
    record_id: "decision-1", category: "decision",
    content: "Use the verified repository path.", source: "user_decision",
    source_ref: "phone:decision-1", visibility: "project", recorded_at: 1_000_000 }]);
  assert.equal(sent[0]?.status, "recorded");
});

test("a foreign Task and an unbound host cannot accept a decision", async () => {
  let writes = 0;
  const sent: KnowledgeWriteResult[] = [];
  const options = {
    now: () => 1_000_001, endpointId: "host-1",
    snapshot: () => ({ tasks: [{ taskId: "other-task" }],
      bindings: [{ endpointId: "host-2" }] }),
    record: async () => { writes += 1; return true; },
    send: async (reply: KnowledgeWriteResult) => { sent.push(reply); },
  };
  await handleKnowledgeWrite(request, options);
  assert.equal(writes, 0);
  assert.equal(sent[0]?.status, "rejected");
  assert.equal(sent[0]?.reason?.includes("Project"), true);
});

test("a correction preserves the prior record identity for Engine validation", async () => {
  let correction: string | null | undefined;
  await handleKnowledgeWrite({ ...request, recordId: "decision-2",
    repositoryId: "repo-1", supersedesRecordId: "decision-1" }, {
    now: () => 1_000_001, endpointId: "host-1",
    snapshot: () => ({ tasks: [{ taskId: "task-1" }],
      bindings: [{ endpointId: "host-1" }] }),
    record: async (input) => { correction = input.supersedes_record_id; return true; },
    send: async () => {},
  });
  assert.equal(correction, "decision-1");
});
