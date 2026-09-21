import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectKnowledge, recordProjectKnowledge, recordsFromEvent, syncProjectKnowledge,
} from "../../../apps/bridge/src/engine/runtime/engine-memory";
import { parseEngineResponse, type EngineOperation, type EngineResult } from "../../../apps/bridge/src/engine/protocol/engine-protocol";
import { projectScopedSnapshot } from "../../../apps/bridge/src/mesh/snapshot/window";
import { cortexSnapshotEvidence } from "../../../apps/bridge/src/cortex/integration";
import { MeshStore } from "../../../apps/bridge/src/mesh/store";
import type { MeshSnapshot } from "../../../packages/protocol/schema";

const record = (recordId: string, taskId: string, visibility: "task" | "project") => ({
  projectId: "mesh", taskId, recordId, category: "decision" as const,
  content: `${recordId} decision`, source: "agent_report" as const, sourceRef: recordId,
  visibility, recordedAt: 10, streamVersion: 1,
});

test("task scoped context excludes another task's private memory before Cortex compilation", () => {
  const snapshot: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh",
    project: { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: ["task-a", "task-b"].map((taskId) => ({ projectId: "mesh", taskId,
      title: taskId, goal: taskId, state: "working", createdAt: 1, updatedAt: 10 })),
    executions: [], claims: [], dependencies: [], events: [], generatedAt: 10,
    knowledge: [record("private", "task-a", "task"), record("shared", "task-a", "project")],
  };
  const scoped = projectScopedSnapshot(snapshot, ["task-b"]);
  assert.deepEqual(scoped?.knowledge?.map((item) => item.recordId), ["shared"]);
  const evidence = cortexSnapshotEvidence(scoped!, "task-b");
  assert.equal(evidence.some((item) => item.content.includes("private decision")), false);
  assert.equal(evidence.some((item) => item.content.includes("shared decision")), true);
  assert.equal(evidence.find((item) => item.id === "knowledge.shared")?.state, "unverified");
});

test("Engine memory response rejects records from another Project", () => {
  const response = (projectId: string) => ({
    protocol_version: 1, request_id: "read", status: "ok", result: {
      operation: "memory.history", page: { project_id: "mesh", incomplete: false,
        next_before_version: null, entries: [{
          project_id: projectId, task_id: "task-a", record_id: "decision",
          category: "decision", content: "Keep the repository identity",
          source: "agent_report", source_ref: "event", visibility: "project",
          recorded_at: 10, stream_version: 1,
        }] },
    },
  });
  assert.equal(parseEngineResponse(response("mesh"), "read").operation, "memory.history");
  assert.throws(() => parseEngineResponse(response("other"), "read"));
});

test("Engine scoped read filters a mismatched private record defensively", async () => {
  const client = { request: async (_input: EngineOperation): Promise<EngineResult> => ({
    operation: "memory.history", page: { project_id: "mesh", incomplete: false,
      next_before_version: null, entries: [
        { project_id: "mesh", task_id: "task-a", record_id: "private", category: "decision",
          content: "Private", source: "agent_report", source_ref: "event-a",
          visibility: "task", recorded_at: 10, stream_version: 1 },
        { project_id: "mesh", task_id: "task-a", record_id: "shared", category: "result",
          content: "Shared", source: "agent_report", source_ref: "event-b",
          visibility: "project", recorded_at: 11, stream_version: 2 },
      ] },
  }), close: () => undefined };
  const values = await projectKnowledge("mesh", "task-b", {
    env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
  });
  assert.deepEqual(values?.map((item) => item.recordId), ["shared"]);
});

test("a completed Task enters Memory as an agent report with its source event", () => {
  const values = recordsFromEvent({ type: "mesh.event", sessionId: "task-a",
    eventId: "completed", projectId: "mesh", taskId: "task-a",
    sourceSessionId: "native", eventType: "TASK_COMPLETED", createdAt: 10,
    payload: { summary: "Tests passed", commitSha: "a".repeat(40) } });
  assert.equal(values[0]?.source, "agent_report");
  assert.equal(values[0]?.visibility, "project");
  assert.equal(values[0]?.commit_sha, "a".repeat(40));
});

test("knowledge import keeps answers private and does not turn progress into decisions", () => {
  const base = { type: "mesh.event" as const, sessionId: "task-a", eventId: "answer",
    projectId: "mesh", taskId: "task-a", sourceSessionId: "native", createdAt: 10 };
  assert.deepEqual(recordsFromEvent({ ...base, eventType: "AGENT_ANSWER",
    payload: { answer: "Try the existing adapter" } }).map((item) => item.visibility), ["task"]);
  assert.deepEqual(recordsFromEvent({ ...base, eventType: "TASK_BLOCKED",
    payload: { reason: "Adapter failed" } }).map((item) => item.category), ["attempt"]);
  assert.deepEqual(recordsFromEvent({ ...base, eventType: "TASK_PROGRESS",
    payload: { summary: "Still investigating" } }), []);
  const capsule = { taskId: "task-a", goal: "Fix", currentStatus: "waiting",
    sourceProvider: "codex" as const, sourceComputer: "mac-a",
    targetProvider: "claude" as const, targetComputer: "mac-b",
    repository: "repo", baseSha: "a".repeat(40), filesChanged: [],
    dependencies: [], resourceClaims: [], remainingWork: [],
    importantDecisions: ["Keep stable identity", "Use exact scope"], createdAt: 10 };
  const decisions = recordsFromEvent({ ...base, eventType: "HANDOFF_REQUEST",
    payload: { capsule } });
  assert.equal(decisions.length, 2);
  assert.notEqual(decisions[0]?.record_id, decisions[1]?.record_id);
  assert.equal(decisions[0]?.record_id.startsWith("capsule-"), true);
  assert.equal(decisions[0]?.repository_id, "repo");
  assert.equal(decisions[0]?.source, "task_capsule");
});

test("bounded event backfill submits once and never treats Engine failure as persisted", async () => {
  const calls: EngineOperation[] = [];
  let fail = true;
  const client = { request: async (input: EngineOperation): Promise<EngineResult> => {
    calls.push(input);
    if (fail) throw new Error("Engine offline");
    if (input.operation !== "memory.record") throw new Error("unexpected read");
    return { operation: "memory.recorded", record_id: input.input.record_id, stream_version: 1 };
  }, close: () => undefined };
  const event = { type: "mesh.event" as const, sessionId: "task-a", eventId: "backfill-unique",
    projectId: "mesh", taskId: "task-a", sourceSessionId: "native",
    eventType: "TASK_COMPLETED" as const, createdAt: 10,
    payload: { summary: "Passed" } };
  const snapshot: MeshSnapshot = { type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh",
    project: { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: [{ projectId: "mesh", taskId: "task-a", title: "A", goal: "A",
      state: "completed", createdAt: 1, updatedAt: 10 }],
    executions: [], claims: [], dependencies: [], events: [event], generatedAt: 10 };
  const options = { env: { GRANTTAP_ENGINE_ENABLED: "1" }, client };
  await syncProjectKnowledge(snapshot, options);
  assert.equal(calls.length, 1);
  fail = false;
  await syncProjectKnowledge(snapshot, options);
  await syncProjectKnowledge(snapshot, options);
  assert.equal(calls.length, 2);
  assert.equal(await recordProjectKnowledge(recordsFromEvent(event)[0]!, {
    env: {}, client,
  }), false);
  assert.equal(calls.length, 2);
});

test("Project memory projection survives bridge restart and rejects changed record identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-memory-projection-"));
  try {
    const path = join(directory, "project-mesh.json");
    const store = new MeshStore(path, () => 20);
    store.upsertProject({ projectId: "mesh", name: "Mesh",
      canonicalRepositoryId: "repo", createdAt: 1 });
    store.cacheKnowledge("mesh", [record("shared", "task-a", "project"),
      record("private", "task-a", "task")]);
    const restored = new MeshStore(path, () => 21);
    assert.deepEqual(restored.snapshot("mesh")?.knowledge?.map((item) => item.recordId), ["shared"]);
    const incoming = restored.snapshot("mesh")!;
    incoming.knowledge = [{ ...record("shared", "task-a", "project"), content: "tampered" }];
    assert.throws(() => restored.mergeSnapshot(incoming), /identity conflict/);
    assert.equal(restored.snapshot("mesh")?.knowledge?.[0]?.content, "shared decision");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
