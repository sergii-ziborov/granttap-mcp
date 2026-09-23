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
import {
  activeProjectKnowledge, supersededProjectKnowledgeIds,
} from "../../../apps/bridge/src/mesh/knowledge/active";
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

test("Project projection asks Engine for shared records before applying the page limit", async () => {
  let requested: EngineOperation | undefined;
  const client = { request: async (input: EngineOperation): Promise<EngineResult> => {
    requested = input;
    return { operation: "memory.history", page: { project_id: "mesh",
      entries: [], next_before_version: null, incomplete: false } };
  }, close: () => undefined };
  await projectKnowledge("mesh", undefined, { env: { GRANTTAP_ENGINE_ENABLED: "1" }, client });
  assert.equal(requested?.operation, "memory.history");
  if (requested?.operation === "memory.history") {
    assert.equal(requested.input.visibility, "project");
    assert.equal(requested.input.include_superseded, true);
    assert.equal(requested.input.limit, 64);
  }
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

test("a corrected decision survives store restart and stale Mesh replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-memory-correction-"));
  try {
    const path = join(directory, "project-mesh.json");
    const store = new MeshStore(path, () => 20);
    store.upsertProject({ projectId: "mesh", name: "Mesh",
      canonicalRepositoryId: "repo", createdAt: 1 });
    const old = record("old", "task-a", "project");
    store.cacheKnowledge("mesh", [old]);
    const stale = store.snapshot("mesh")!;
    const replacement = { ...record("new", "task-a", "project"),
      content: "Reviewed decision", streamVersion: 2, recordedAt: 11,
      supersedesRecordId: "old" };
    store.cacheKnowledge("mesh", [replacement]);
    const restored = new MeshStore(path, () => 21);
    assert.deepEqual(restored.snapshot("mesh")?.knowledge?.map((item) => item.recordId), ["new"]);
    assert.deepEqual(restored.snapshot("mesh")?.supersededKnowledgeRecordIds, ["old"]);
    restored.mergeSnapshot(stale);
    assert.deepEqual(restored.snapshot("mesh")?.knowledge?.map((item) => item.recordId), ["new"]);
    assert.deepEqual(restored.snapshot("mesh")?.supersededKnowledgeRecordIds, ["old"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a correction from another Project or category cannot hide shared memory", () => {
  const old = record("old", "task-a", "project");
  const foreign = { ...record("foreign", "task-a", "project"),
    projectId: "other", supersedesRecordId: "old" };
  const wrongKind = { ...record("result", "task-a", "project"),
    category: "result" as const, supersedesRecordId: "old" };
  assert.deepEqual(activeProjectKnowledge("mesh", [old, foreign, wrongKind])
    .map((item) => item.recordId), ["old", "result"]);
});

test("bounded correction tombstones retain the newest decisions", () => {
  const corrections = Array.from({ length: 129 }, (_, index) => ({
    ...record(`new-${index}`, "task-a", "project"), recordedAt: index + 1,
    supersedesRecordId: `old-${String(129 - index).padStart(3, "0")}`,
  }));
  const ids = supersededProjectKnowledgeIds("mesh", corrections);
  assert.equal(ids.length, 128);
  assert.equal(ids.includes("old-001"), true);
  assert.equal(ids.includes("old-129"), false);
});

test("corrected capsule decisions never return as Cortex event evidence", () => {
  const event = { type: "mesh.event" as const, sessionId: "task-a", eventId: "handoff",
    projectId: "mesh", taskId: "task-a", sourceSessionId: "native",
    eventType: "HANDOFF_REQUEST" as const, createdAt: 10,
    payload: { capsule: { taskId: "task-a", goal: "Fix", currentStatus: "working",
      sourceProvider: "codex" as const, sourceComputer: "mac-a",
      targetProvider: "claude" as const, targetComputer: "mac-b",
      repository: "repo", baseSha: "a".repeat(40), filesChanged: [],
      dependencies: [], resourceClaims: [], remainingWork: [],
      importantDecisions: ["Old decision", "Still valid"], createdAt: 10 } } };
  const oldId = recordsFromEvent(event)[0]!.record_id;
  const snapshot: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "mesh", projectId: "mesh",
    project: { projectId: "mesh", name: "Mesh", canonicalRepositoryId: "repo", createdAt: 1 },
    tasks: [{ projectId: "mesh", taskId: "task-a", title: "A", goal: "A",
      state: "working", createdAt: 1, updatedAt: 10 }],
    executions: [], claims: [], dependencies: [], events: [event], generatedAt: 12,
    knowledge: [{ ...record("new", "task-a", "project"), content: "Reviewed decision",
      supersedesRecordId: oldId }], supersededKnowledgeRecordIds: [oldId],
  };
  const evidence = cortexSnapshotEvidence(snapshot, "task-a");
  assert.equal(evidence.some((item) => item.content.includes("Old decision")), false);
  assert.equal(evidence.some((item) => item.content.includes("Still valid")), true);
  assert.equal(evidence.some((item) => item.content.includes("Reviewed decision")), true);
});

test("retained structured events older than the phone window enter Memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-memory-import-"));
  try {
    const store = new MeshStore(join(directory, "mesh.json"), () => 10);
    store.upsertProject({ projectId: "mesh", name: "Mesh",
      canonicalRepositoryId: "repo", createdAt: 1 });
    for (let index = 0; index < 130; index += 1) {
      assert.equal(store.acceptEvent({
        type: "mesh.event", sessionId: "task-a", eventId: `import-${index}`,
        projectId: "mesh", taskId: "task-a", sourceSessionId: "native",
        eventType: "AGENT_ANSWER", createdAt: index + 1,
        payload: { answer: `Recorded answer ${index}` },
      }), true);
    }
    assert.equal(store.eventsForProject("mesh").length, 128);
    const events = store.historyEventsForProject("mesh");
    assert.equal(events.length, 130);
    const calls: string[] = [];
    const client = { request: async (input: EngineOperation): Promise<EngineResult> => {
      if (input.operation !== "memory.record") throw new Error("unexpected read");
      calls.push(input.input.record_id);
      return { operation: "memory.recorded", record_id: input.input.record_id,
        stream_version: calls.length };
    }, close: () => undefined };
    await syncProjectKnowledge({ projectId: "mesh", events }, {
      env: { GRANTTAP_ENGINE_ENABLED: "1" }, client,
    });
    assert.equal(calls.length, 130);
    assert.equal(calls[0], "import-0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
