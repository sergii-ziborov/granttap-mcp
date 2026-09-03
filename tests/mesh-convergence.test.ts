import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshEvent, SessionInfo, TaskCapsule } from "../packages/protocol/schema";
import {
  hasUncommittedWork,
  linkSessionsToProjects,
  meshTaskTitle,
} from "../apps/bridge/src/mesh/catalog";
import { preferExecution, preferTask } from "../apps/bridge/src/mesh/convergence";
import { handoffReceipt } from "../apps/bridge/src/mesh/handoff";
import {
  UNCOMMITTED_WORK_REASON,
  UNREADABLE_WORKING_TREE_REASON,
  handoffReadiness,
} from "../apps/bridge/src/mesh/readiness";
import { MeshStore } from "../apps/bridge/src/mesh/store";

const now = 1_800_000_000_000;

async function freshStore(): Promise<MeshStore> {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-convergence-"));
  return new MeshStore(join(root, "mesh.json"), () => now);
}

function project() {
  return {
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
}

function capsuleTo(targetProvider: "codex" | "cursor"): TaskCapsule {
  return {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider,
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), filesChanged: [], dependencies: [], resourceClaims: [],
    remainingWork: [], importantDecisions: [], workingTree: "clean", createdAt: now,
  };
}

function event(
  eventId: string,
  eventType: MeshEvent["eventType"],
  payload: MeshEvent["payload"],
  sourceSessionId = "claude",
): MeshEvent {
  return {
    type: "mesh.event", sessionId: "task", eventId, projectId: "project", taskId: "task",
    sourceSessionId, eventType, createdAt: now + eventId.length, payload,
  };
}

async function handedOffStore(): Promise<MeshStore> {
  const store = await freshStore();
  store.upsertProject(project());
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "claude", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "main", startedAt: now,
  });
  return store;
}

test("a late snapshot never resurrects a previous owner or reopens a finished task", async () => {
  const store = await handedOffStore();
  const stale = store.snapshot("project")!;
  const capsule = capsuleTo("codex");
  assert.equal(store.acceptEvent(event("request", "HANDOFF_REQUEST", { capsule })), true);
  const receipt = handoffReceipt(capsule, "claude", "codex", now + 20);
  assert.equal(store.acceptEvent({
    ...event("accepted", "HANDOFF_ACCEPTED", { receipt }, "codex"), targetSessionId: "claude",
  }), true);
  assert.equal(store.task("task")?.ownerSessionId, "codex");
  assert.equal(store.acceptEvent(event("done", "TASK_COMPLETED", { summary: "Shipped" })), true);
  assert.equal(store.task("task")?.state, "completed");

  store.mergeSnapshot(stale);
  assert.equal(store.task("task")?.ownerSessionId, "codex", "an old snapshot cannot restore an owner");
  assert.equal(store.task("task")?.state, "completed", "an old snapshot cannot reopen the task");
  assert.equal(store.snapshot("project")?.tasks[0]?.ownerSessionId, "codex");
});

test("a former owner and a late progress event cannot move a task that already moved on", async () => {
  const store = await handedOffStore();
  const first = capsuleTo("codex");
  const second = capsuleTo("cursor");
  assert.equal(store.acceptEvent(event("request-codex", "HANDOFF_REQUEST", { capsule: first })), true);
  assert.equal(store.acceptEvent({
    ...event("accept-codex", "HANDOFF_ACCEPTED", {
      receipt: handoffReceipt(first, "claude", "codex", now + 20),
    }, "codex"),
    targetSessionId: "claude",
  }), true);
  assert.equal(store.task("task")?.ownerSessionId, "codex");

  // A handoff the previous owner had already published finally reaches cursor.
  assert.equal(store.acceptEvent(event("request-cursor", "HANDOFF_REQUEST", { capsule: second })), true);
  assert.equal(store.acceptEvent({
    ...event("accept-cursor", "HANDOFF_ACCEPTED", {
      receipt: handoffReceipt(second, "claude", "cursor", now + 30),
    }, "cursor"),
    targetSessionId: "claude",
  }), true);
  assert.equal(store.task("task")?.ownerSessionId, "codex", "only the current owner may hand a task on");

  assert.equal(store.acceptEvent(event("done", "TASK_COMPLETED", { summary: "Shipped" })), true);
  assert.equal(store.acceptEvent(event("late", "TASK_PROGRESS", { summary: "Still typing" })), true);
  assert.equal(store.task("task")?.state, "completed", "a finished task is not reopened by an old event");
});

test("the catalog cannot take a task back from the agent that owns it now", async () => {
  const store = await handedOffStore();
  const capsule = capsuleTo("codex");
  store.acceptEvent(event("request", "HANDOFF_REQUEST", { capsule }));
  store.acceptEvent({
    ...event("accepted", "HANDOFF_ACCEPTED", {
      receipt: handoffReceipt(capsule, "claude", "codex-remote", now + 20),
    }, "codex-remote"),
    targetSessionId: "claude",
  });
  store.linkExecution({
    taskId: "task", sessionId: "codex-remote", provider: "codex", computerId: "Workstation",
    workspace: "/repo", startedAt: now + 20,
  });
  assert.equal(store.task("task")?.ownerSessionId, "codex-remote");

  const session: SessionInfo = {
    sessionId: "claude", agent: "claude", title: "Pairing refactor", cwd: "/repo",
    branch: "main", state: "working", startedAt: now, lastActivityAt: now + 60_000,
    tokensSession: 10, tokensLastTurn: 2,
  };
  linkSessionsToProjects(store, [session], "MacBook", () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  }));
  assert.equal(store.task("task")?.ownerSessionId, "codex-remote", "a live old session is not the owner");
  assert.equal(store.task("task")?.state, "working");
  const previous = store.snapshot("project")?.executions
    .find((item) => item.sessionId === "claude");
  assert.equal(previous?.endedAt, now + 20, "a handed-off execution stays closed");
});

test("untracked work counts as uncommitted and an unreadable tree stays unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-dirty-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "-q", "-m", "base"]);
  assert.equal(hasUncommittedWork(root), false);

  await writeFile(join(root, "notes.md"), "a file no commit would carry\n");
  assert.equal(hasUncommittedWork(root), true, "untracked files would be left behind");

  const outside = await mkdtemp(join(tmpdir(), "granttap-mesh-nogit-"));
  assert.equal(hasUncommittedWork(outside), undefined, "an unreadable tree is not clean");
});

test("handoff readiness refuses a working tree it could not read", async () => {
  const base = { latestCommit: "abc1234", baseSha: "abc1234", repository: "repo" };
  const clean = handoffReadiness({
    capsule: { ...base, workingTree: "clean" } as TaskCapsule,
    targetProviderEnabled: true, conflicts: [],
  });
  assert.equal(clean.ready, true);

  const dirty = handoffReadiness({
    capsule: { ...base, workingTree: "dirty" } as TaskCapsule,
    targetProviderEnabled: true, conflicts: [],
  });
  assert.equal(dirty.blockedReason, UNCOMMITTED_WORK_REASON);

  for (const workingTree of ["unknown", undefined]) {
    const unknown = handoffReadiness({
      capsule: { ...base, workingTree } as TaskCapsule,
      targetProviderEnabled: true, conflicts: [],
    });
    assert.equal(unknown.ready, false);
    assert.equal(unknown.blockedReason, UNREADABLE_WORKING_TREE_REASON);
  }
});

test("two computers holding the same revision still converge on one task", () => {
  const base = {
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    revision: 4, createdAt: now, updatedAt: now,
  } as const;
  const working = { ...base, state: "working" as const, ownerSessionId: "claude" };
  const finished = { ...base, state: "completed" as const, ownerSessionId: "codex" };
  assert.deepEqual(preferTask(working, finished), finished, "finished work survives a tie");
  assert.deepEqual(preferTask(finished, working), finished, "in either arrival order");

  const blocked = { ...base, state: "blocked" as const, ownerSessionId: "claude" };
  assert.deepEqual(preferTask(working, blocked), preferTask(blocked, working));

  const execution = {
    taskId: "task", sessionId: "claude", provider: "claude" as const, computerId: "MacBook",
    workspace: "/repo", startedAt: now, updatedAt: now,
  };
  const ended = { ...execution, endedAt: now + 10 };
  assert.equal(preferExecution(execution, ended).endedAt, now + 10);
  assert.equal(preferExecution(ended, execution).endedAt, now + 10, "an ended execution stays ended");
  const fresher = { ...execution, uncommitted: true, updatedAt: now + 5 };
  assert.equal(preferExecution({ ...execution, uncommitted: false }, fresher).uncommitted, true);
  assert.deepEqual(
    preferExecution(execution, { ...execution, branch: "other" }),
    preferExecution({ ...execution, branch: "other" }, execution),
  );
});

test("a session that vanished stops holding the task, its title, and its state", async () => {
  const store = await freshStore();
  store.upsertProject(project());
  store.upsertTask({
    taskId: "task", projectId: "project", title: "An old chat title", goal: "Old goal",
    state: "working", ownerSessionId: "claude-gone", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "claude-gone", provider: "claude", computerId: "MacBook",
    workspace: "/repo", startedAt: now,
  });

  // The next scan sees a different live claude session in the same checkout.
  const live: SessionInfo = {
    sessionId: "claude-live", agent: "claude", title: "What the chat is called now",
    cwd: "/repo", state: "idle", startedAt: now + 10, lastActivityAt: now + 10,
    tokensSession: 1, tokensLastTurn: 1,
  };
  const inspect = () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  });
  linkSessionsToProjects(store, [live], "MacBook", inspect);

  // The live session opens its own task; the old one stays as history and, with
  // its execution closed, no longer passes for current work.
  const executions = store.projectIds()
    .flatMap((id) => store.snapshot(id)?.executions ?? []);
  assert.ok(
    executions.find((item) => item.sessionId === "claude-gone")?.endedAt,
    "an execution this computer no longer runs is closed",
  );
  assert.equal(
    executions.filter((item) => item.endedAt == null).map((item) => item.sessionId).join(),
    "claude-live",
    "only the live session is open",
  );
  assert.equal(store.task("task")?.title, "An old chat title", "history keeps its own name");
});

test("an idle native session keeps its execution without claiming active work", async () => {
  const store = await freshStore();
  const idle: SessionInfo = {
    sessionId: "codex-idle", agent: "codex", title: "Finished locally", cwd: "/repo",
    state: "idle", startedAt: now - 60_000, lastActivityAt: now,
    tokensSession: 1, tokensLastTurn: 1,
  };

  const [linked] = linkSessionsToProjects(store, [idle], "MacBook", () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  }));
  const snapshot = store.snapshot(linked!.projectId!)!;
  const execution = snapshot.executions.find((item) => item.sessionId === idle.sessionId);

  assert.equal(execution?.endedAt, undefined, "the idle chat remains available to continue");
  assert.equal(
    snapshot.tasks.find((item) => item.taskId === linked!.taskId)?.state,
    "planned",
    "an idle chat is not presented as active work",
  );
});

test("a provider missing from this scan keeps its executions open", async () => {
  const store = await freshStore();
  store.upsertProject(project());
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Codex work", goal: "Goal",
    state: "working", ownerSessionId: "codex-session", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "codex-session", provider: "codex", computerId: "MacBook",
    workspace: "/repo", startedAt: now,
  });
  // Only claude was observed: a Codex CLI that is temporarily unavailable must
  // not have its sessions declared over.
  store.closeVanishedExecutions("MacBook", new Set(["claude-live"]), new Set(["claude"]));
  assert.equal(
    store.snapshot("project")?.executions.find((item) => item.sessionId === "codex-session")?.endedAt,
    undefined,
  );
});

test("a second computer joining a Project does not silence the first one's binding", async () => {
  const store = await freshStore();
  store.upsertProject(project());
  // The other machine published this repository first, under its own binding.
  store.upsertBinding({
    bindingId: "binding-workstation", projectId: "project", endpointId: "Workstation",
    repositoryId: "github.com/example/granttap", displayName: "granttap", available: true,
  });

  const session: SessionInfo = {
    sessionId: "claude", agent: "claude", title: "Pairing refactor", cwd: "/repo",
    branch: "main", state: "working", startedAt: now, lastActivityAt: now + 60_000,
    tokensSession: 10, tokensLastTurn: 2,
  };
  // Reusing the remote binding's id for a local endpoint is a conflict the
  // store rejects, and the throw used to take the whole catalog pass with it.
  linkSessionsToProjects(store, [session], "MacBook", () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  }));

  const bindings = store.snapshot("project")?.bindings ?? [];
  assert.deepEqual(
    bindings.map((binding) => binding.endpointId).sort(),
    ["MacBook", "Workstation"],
    "both computers report their own binding for the shared repository",
  );
  assert.equal(
    store.bindingForEndpoint("github.com/example/granttap", "MacBook")?.projectId,
    "project",
  );
  // The rest of the pass survived too, which is what the throw used to cost.
  assert.equal(store.snapshot("project")?.tasks.length, 1);
});

test("a Task is named by its chat, and never by a whole agent summary", () => {
  // A chat that named itself keeps that name.
  assert.equal(
    meshTaskTitle({ title: "Pairing refactor", summary: "Long\nparagraph" } as never, "claude"),
    "Pairing refactor",
  );
  // Without one, only the opening line of the summary is a candidate: the rest
  // is a paragraph about the work, and publishing it named Tasks with prose.
  assert.equal(
    meshTaskTitle(
      { summary: "Fix the relay handshake\n\nIt drops the first frame." } as never,
      "claude",
    ),
    "Fix the relay handshake",
  );
  // Blank leading lines are not a name either.
  assert.equal(
    meshTaskTitle({ summary: "\n\n  Rebuild the index  \n" } as never, "codex"),
    "Rebuild the index",
  );
  assert.equal(meshTaskTitle({} as never, "codex"), "codex task");
  assert.equal(meshTaskTitle({ summary: "   " } as never, "grok"), "grok task");
});

test("one chat stays one Task when a second computer reports it", async () => {
  const store = await freshStore();
  store.upsertProject(project());
  const inspect = () => ({
    root: "/repo", canonicalRepositoryId: "github.com/example/granttap", worktree: "/repo",
  });
  const session: SessionInfo = {
    sessionId: "shared-chat", agent: "claude", title: "Pairing refactor", cwd: "/repo",
    branch: "main", state: "working", startedAt: now, lastActivityAt: now + 1_000,
    tokensSession: 10, tokensLastTurn: 2,
  };

  // An agent can read another machine's conversations, and a Mac is renamed by
  // the network it joins, so the same chat legitimately arrives under two
  // computers. Keying the Task by computer minted a second one either way.
  linkSessionsToProjects(store, [session], "MacBook", inspect);
  linkSessionsToProjects(store, [session], "Mac.lan", inspect);

  // The repository resolves to its own derived Project when nothing bound it.
  const snapshots = store.projectIds().flatMap((id) => store.snapshot(id) ?? []);
  const snapshot = snapshots.find((item) => item.tasks.length > 0);
  assert.equal(
    snapshots.reduce((total, item) => total + item.tasks.length, 0), 1,
    "one chat is one Task",
  );
  assert.deepEqual(
    (snapshot?.executions ?? []).map((item) => item.computerId).sort(),
    ["Mac.lan", "MacBook"],
    "each computer still reports its own execution of that Task",
  );
  assert.equal(
    new Set((snapshot?.executions ?? []).map((item) => item.taskId)).size, 1,
    "both executions belong to the same Task",
  );
});

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
