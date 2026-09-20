import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshEvent, SessionInfo, TaskCapsule } from "../../../packages/protocol/schema";
import {
  hasUncommittedWork,
  linkSessionsToProjects,
  meshTaskTitle,
} from "../../../apps/bridge/src/mesh/catalog";
import { preferExecution, preferTask } from "../../../apps/bridge/src/mesh/admin/convergence";
import { handoffReceipt } from "../../../apps/bridge/src/mesh/handoff";
import {
  UNCOMMITTED_WORK_REASON,
  UNREADABLE_WORKING_TREE_REASON,
  handoffReadiness,
} from "../../../apps/bridge/src/mesh/tasks/readiness";
import { MeshStore } from "../../../apps/bridge/src/mesh/store";
import { now, freshStore, project, capsuleTo, event, handedOffStore } from "../../support/mesh/mesh-convergence-fixtures";

test("a chat already split across two Tasks is rejoined when the store loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-split-"));
  const path = join(root, "mesh.json");
  // What a machine renamed by its network left behind: one chat, two Tasks,
  // and an execution under a computer that will never report again.
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [project()],
    bindings: [],
    tasks: [
      { taskId: "task-old", projectId: "project", title: "Pairing refactor",
        goal: "Finish pairing", state: "working", createdAt: now, updatedAt: now },
      { taskId: "task-new", projectId: "project", title: "Pairing refactor",
        goal: "Finish pairing", state: "working", createdAt: now + 5_000, updatedAt: now + 5_000 },
    ],
    executions: [
      { taskId: "task-old", sessionId: "chat", provider: "claude",
        computerId: "Mac.lan", workspace: "/repo", startedAt: now },
      { taskId: "task-new", sessionId: "chat", provider: "claude",
        computerId: "Serhiis-MacBook-Pro.local", workspace: "/repo", startedAt: now + 5_000 },
    ],
    claims: [], dependencies: [], events: [], receipts: [],
  }));

  const store = new MeshStore(path, () => now);
  const snapshot = store.snapshot("project");
  assert.equal(snapshot?.tasks.length, 1, "one conversation is one Task");
  // The older Task wins: it is what dependencies, claims, and events reference.
  assert.equal(snapshot?.tasks[0]?.taskId, "task-old");
  assert.deepEqual(
    (snapshot?.executions ?? []).map((item) => item.taskId), ["task-old", "task-old"],
    "both computers' executions now belong to the surviving Task",
  );
});

test("a duplicate on one computer is rejoined though it carries no execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-owner-"));
  const path = join(root, "mesh.json");
  // Executions are keyed by computer, provider, and chat, so two Tasks for one
  // chat on one computer share an execution and the other Task holds none.
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [project()],
    bindings: [],
    tasks: [
      { taskId: "task-old", projectId: "project", title: "Pairing refactor",
        goal: "Finish pairing", state: "working", ownerSessionId: "chat",
        createdAt: now, updatedAt: now },
      { taskId: "task-again", projectId: "project", title: "Pairing refactor",
        goal: "Publish it", state: "working", ownerSessionId: "chat",
        createdAt: now + 5_000, updatedAt: now + 5_000 },
    ],
    executions: [
      { taskId: "task-old", sessionId: "chat", provider: "claude",
        computerId: "Mac.lan", workspace: "/repo", startedAt: now },
    ],
    claims: [], dependencies: [], events: [], receipts: [],
  }));

  const snapshot = new MeshStore(path, () => now).snapshot("project");
  assert.equal(snapshot?.tasks.length, 1, "one chat is one Task, execution or not");
  assert.equal(snapshot?.tasks[0]?.taskId, "task-old");
});

test("Cursor Task-tool clones are not kept as open mesh work", async () => {
  const store = await freshStore();
  const inspect = () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  });
  const parent: SessionInfo = {
    sessionId: "077ac587-8ac9-459c-b58a-8278f2767635",
    agent: "cursor", title: "GrantTap MCP configuration issues", cwd: "/repo",
    state: "working", startedAt: now, lastActivityAt: now,
    tokensSession: 11, tokensLastTurn: 2,
  };
  const clone: SessionInfo = {
    sessionId: "task-3ef3af57-1111-4111-8111-1234567890ab",
    agent: "cursor", title: "GrantTap MCP configuration issues", cwd: "/repo",
    state: "working", startedAt: now, lastActivityAt: now,
    tokensSession: 0, tokensLastTurn: 0,
  };
  store.upsertProject(project());
  store.upsertTask({
    taskId: "task-clone", projectId: "project",
    title: clone.title ?? "GrantTap", goal: "Continue",
    state: "working", ownerSessionId: clone.sessionId, createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task-clone", sessionId: clone.sessionId, provider: "cursor",
    computerId: "MacBook", workspace: "/repo", startedAt: now,
  });

  const linked = linkSessionsToProjects(store, [parent, clone], "MacBook", inspect);
  assert.deepEqual(linked.map((session) => session.sessionId), [parent.sessionId]);
  assert.ok(linked[0]?.taskId);
  const leftover = store.snapshot("project");
  assert.equal(
    leftover?.executions.some((item) => item.sessionId === clone.sessionId && item.endedAt == null),
    false,
    "a Task-tool clone is not current work",
  );
  const live = store.snapshot(linked[0]!.projectId ?? "project");
  assert.equal(
    live?.executions.some((item) => item.sessionId === parent.sessionId && item.endedAt == null),
    true,
    "the person chat stays the open execution",
  );
});
