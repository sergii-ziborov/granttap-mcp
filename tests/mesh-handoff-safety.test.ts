import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../packages/core/relay-client";
import type {
  MeshEvent, MeshSnapshot, SessionInfo, TaskCapsule,
} from "../packages/protocol/schema";
import { hasUncommittedWork } from "../apps/bridge/src/mesh/catalog";
import { handoffReadiness, UNCOMMITTED_WORK_REASON } from "../apps/bridge/src/mesh/readiness";
import { createMeshRuntime, type MeshRuntimeDependencies } from "../apps/bridge/src/mesh/runtime";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { repositoryHasCommit } from "../apps/bridge/src/mesh/worktree";

const now = 1_800_000_000_000;
const client = {} as RelayClient;

async function gitRepository(dirty: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-handoff-repo-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "-q", "-m", "base"]);
  if (dirty) await writeFile(join(root, "README.md"), "nine hundred uncommitted lines\n");
  return root;
}

async function harness(overrides: Partial<MeshRuntimeDependencies> = {}) {
  const state = await mkdtemp(join(tmpdir(), "granttap-handoff-state-"));
  const store = new MeshStore(join(state, "mesh.json"), () => now);
  const sent: Array<MeshEvent | MeshSnapshot> = [];
  const sessions: SessionInfo[] = [];
  const deps: MeshRuntimeDependencies = {
    store: () => store,
    sessions: () => sessions,
    computer: () => "Workstation",
    now: () => now,
    eventId: (() => { let id = 0; return () => `event-${++id}`; })(),
    providerEnabled: () => true,
    start: async () => ({ ok: true, text: "Started", sessionId: "codex-target" }),
    deliver: async () => ({ ok: true, text: "answered" }),
    send: async (_c, payload) => { sent.push(payload); },
    worktree: () => ({ path: "/repo-worktree", branch: "granttap/codex/task" }),
    hasCommit: () => true,
    ...overrides,
  };
  return { runtime: createMeshRuntime(deps), store, sent, sessions };
}

function sourceSession(cwd: string): SessionInfo {
  return {
    sessionId: "claude-source", agent: "claude", title: "Pairing refactor",
    summary: "Crypto complete", cwd, branch: "claude/pairing", state: "working",
    startedAt: now - 1_000, lastActivityAt: now, tokensSession: 10, tokensLastTurn: 2,
  };
}

test("a handoff that would strand uncommitted work is refused, not narrowed", async () => {
  const repo = await gitRepository(true);
  assert.equal(hasUncommittedWork(repo), true);
  const run = await harness();
  run.sessions.push(sourceSession(repo));
  const source = run.runtime.catalog(run.sessions)[0]!;
  run.sessions[0] = source;

  const prepared = await run.runtime.prepare(client, {
    type: "mesh.handoff.prepare", sessionId: source.sessionId,
    projectId: source.projectId!, taskId: source.taskId!,
    targetProvider: "codex", targetComputer: "Workstation", createdAt: now,
  });
  assert.equal(prepared, false);
  const blocked = run.sent[0] as MeshEvent;
  assert.equal(blocked.eventType, "TASK_BLOCKED");
  assert.equal(blocked.payload.needsUser, true);
  assert.equal(blocked.payload.reason, UNCOMMITTED_WORK_REASON);
  assert.equal(
    run.sent.some((item) => (item as MeshEvent).eventType === "HANDOFF_REQUEST"), false,
    "no capsule leaves the computer while work is uncommitted",
  );
});

test("a clean checkout still hands off and reports its committed state", async () => {
  const repo = await gitRepository(false);
  assert.equal(hasUncommittedWork(repo), false);
  const run = await harness();
  run.sessions.push(sourceSession(repo));
  const source = run.runtime.catalog(run.sessions)[0]!;
  run.sessions[0] = source;
  const execution = run.runtime.snapshots()[0]?.executions[0];
  assert.equal(execution?.uncommitted, false);

  assert.equal(await run.runtime.prepare(client, {
    type: "mesh.handoff.prepare", sessionId: source.sessionId,
    projectId: source.projectId!, taskId: source.taskId!,
    targetProvider: "codex", targetComputer: "Workstation", createdAt: now,
  }), true);
  const request = run.sent[0] as MeshEvent;
  assert.equal(request.eventType, "HANDOFF_REQUEST");
  assert.equal(request.payload.capsule?.dirtyDiffHash, undefined);
});

test("a target without the commit says so instead of failing generically", async () => {
  const run = await harness({ hasCommit: () => false });
  run.store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  run.store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude-source", createdAt: now, updatedAt: now,
  });
  run.store.linkExecution({
    taskId: "task", sessionId: "checkout", provider: "claude", computerId: "Workstation",
    workspace: "/repo", branch: "main", worktree: "/repo", startedAt: now,
  });
  const capsule: TaskCapsule = {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider: "codex",
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), latestCommit: "b".repeat(40), filesChanged: [],
    resourceClaims: ["packages/pairing/**"], dependencies: [],
    remainingWork: ["Finish"], importantDecisions: [], createdAt: now,
  };
  await run.runtime.handle(client, {
    type: "mesh.event", sessionId: "task", eventId: "request", projectId: "project",
    taskId: "task", sourceSessionId: "claude-source", eventType: "HANDOFF_REQUEST",
    createdAt: now, expiresAt: now + 60_000, payload: { capsule },
  });
  const rejected = run.sent[0] as MeshEvent;
  assert.equal(rejected.eventType, "HANDOFF_REJECTED");
  assert.match(rejected.payload.reason ?? "", /not on this computer/);
  assert.match(rejected.payload.reason ?? "", new RegExp("b".repeat(40)));

  // A claim the capsule owns blocks the handoff even with no changed files.
  const claimed = await harness();
  claimed.store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  claimed.store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude-source", createdAt: now, updatedAt: now,
  });
  claimed.store.linkExecution({
    taskId: "task", sessionId: "checkout", provider: "claude", computerId: "Workstation",
    workspace: "/repo", branch: "main", worktree: "/repo", startedAt: now,
  });
  claimed.store.claim({
    claimId: "other", projectId: "project", taskId: "task", ownerSessionId: "codex-other",
    resource: "packages/pairing/**", mode: "claim", createdAt: now, expiresAt: now + 600_000,
  });
  await claimed.runtime.handle(client, {
    type: "mesh.event", sessionId: "task", eventId: "request", projectId: "project",
    taskId: "task", sourceSessionId: "claude-source", eventType: "HANDOFF_REQUEST",
    createdAt: now, expiresAt: now + 60_000, payload: { capsule },
  });
  const conflict = claimed.sent[0] as MeshEvent;
  assert.equal(conflict.eventType, "HANDOFF_REJECTED");
  assert.match(conflict.payload.reason ?? "", /codex-other currently claims/);
});

test("readiness names one blocking reason at a time", async () => {
  const repo = await gitRepository(false);
  assert.equal(repositoryHasCommit(repo, "a".repeat(40)), false);
  const ready = handoffReadiness({
    capsule: { dirtyDiffHash: undefined, latestCommit: "abc1234", baseSha: "abc1234",
      repository: "github.com/example/granttap" } as TaskCapsule,
    targetProviderEnabled: true,
    conflicts: [],
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.checks.every((check) => check.ready), true);

  const missing = handoffReadiness({ targetProviderEnabled: true, conflicts: [] });
  assert.equal(missing.ready, false);
  assert.match(missing.blockedReason ?? "", /No git repository/);

  const disabled = handoffReadiness({
    capsule: { dirtyDiffHash: undefined, latestCommit: "abc1234", baseSha: "abc1234",
      repository: "repo" } as TaskCapsule,
    targetProviderEnabled: false,
    conflicts: [],
  });
  assert.equal(disabled.ready, false);
  assert.match(disabled.blockedReason ?? "", /disabled in GrantTap Settings/);
});
