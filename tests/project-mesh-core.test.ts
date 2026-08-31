import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalRepositoryIdentity,
  projectIdentity,
  projectBindingIdentity,
  sanitizedRepositoryRemote,
  taskIdentity,
} from "../apps/bridge/src/mesh/identity";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { classifyHumanAttention } from "../apps/bridge/src/mesh/attention";
import { capsuleHash, handoffReceipt } from "../apps/bridge/src/mesh/handoff";
import { linkSessionsToProjects } from "../apps/bridge/src/mesh/catalog";
import { buildTaskCapsule } from "../apps/bridge/src/mesh/capsule";
import { createHandoffWorktree } from "../apps/bridge/src/mesh/worktree";

const now = 1_800_000_000_000;

test("repository and task identity remain stable across computers and handoff", () => {
  const ssh = canonicalRepositoryIdentity("git@github.com:Example/GrantTap.git", "/mac/repo");
  const https = canonicalRepositoryIdentity("https://github.com/example/granttap.git", "/pc/repo");
  assert.equal(ssh, https);
  const projectId = projectIdentity(ssh);
  assert.equal(projectId, projectIdentity(https));
  assert.equal(
    projectBindingIdentity(projectId, "mac", ssh),
    projectBindingIdentity(projectId, "mac", https),
  );
  assert.notEqual(
    projectBindingIdentity(projectId, "mac", ssh),
    projectBindingIdentity(projectId, "pc", ssh),
  );
  const taskId = taskIdentity(projectId, "claude", "native-a");
  assert.equal(taskId, taskIdentity(projectId, "claude", "native-a"));
  assert.notEqual(taskId, taskIdentity(projectId, "codex", "native-b"));
  assert.equal(canonicalRepositoryIdentity("Local Alias", "/missing"), "local:/missing");
  assert.equal(canonicalRepositoryIdentity(undefined, "/definitely/missing/repo"),
    "local:/definitely/missing/repo");
  assert.equal(
    sanitizedRepositoryRemote("https://oauth2:TOKEN@gitlab.example.test/team/private.git?ref=main"),
    "gitlab.example.test/team/private",
  );
  assert.equal(sanitizedRepositoryRemote("git@github.com:Example/GrantTap.git"),
    "github.com/example/granttap");
  assert.equal(sanitizedRepositoryRemote("/Users/person/private.git"), undefined);
});

test("claims detect overlap and stale owners expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-store-"));
  const meshRoot = await mkdtemp(join(tmpdir(), "granttap-mesh-capsule-state-"));
  const store = new MeshStore(join(meshRoot, "mesh.json"), () => now);
  store.claim({
    claimId: "claim-auth",
    projectId: "project",
    taskId: "task-a",
    ownerSessionId: "claude",
    resource: "src/auth/**",
    mode: "claim",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  assert.equal(store.conflicts("project", "codex", "src/auth/login.ts").length, 1);
  assert.equal(store.conflicts("project", "codex", "src/docs/**").length, 0);
  assert.equal(store.activeClaims(now + 60_001).length, 0);
});

test("mesh event replay is idempotent and expired transient events are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-events-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  const event = {
    type: "mesh.event" as const,
    sessionId: "task",
    eventId: "event-1",
    projectId: "project",
    taskId: "task",
    sourceSessionId: "claude",
    eventType: "TASK_PROGRESS" as const,
    createdAt: now,
    expiresAt: now + 30_000,
    payload: { summary: "Pairing crypto implemented" },
  };
  assert.equal(store.acceptEvent(event), true);
  assert.equal(store.acceptEvent(event), false);
  assert.equal(store.acceptEvent({ ...event, eventId: "expired", expiresAt: now - 1 }), false);
  assert.equal(store.eventsForProject("project").length, 1);
});

test("human attention classification is deterministic and narrow", () => {
  assert.equal(classifyHumanAttention("AGENT_QUESTION", { category: "technical" }), false);
  assert.equal(classifyHumanAttention("AGENT_QUESTION", { category: "product" }), true);
  assert.equal(classifyHumanAttention("CONFLICT", { resolved: false, needsUser: false }), false);
  assert.equal(classifyHumanAttention("CONFLICT", { resolved: false, needsUser: true }), true);
  assert.equal(classifyHumanAttention("TASK_BLOCKED", { needsUser: false }), false);
  assert.equal(classifyHumanAttention("TASK_BLOCKED", { needsUser: true }), true);
  assert.equal(classifyHumanAttention("HANDOFF_REJECTED", { failed: true }), true);
});

test("handoff receipt authenticates the exact bounded capsule", () => {
  const capsule = {
    taskId: "task",
    goal: "Run tests",
    currentStatus: "Ready",
    sourceProvider: "claude" as const,
    sourceComputer: "mac",
    targetProvider: "codex" as const,
    targetComputer: "workstation",
    repository: "github.com/example/granttap",
    baseSha: "a".repeat(40),
    filesChanged: [],
    dependencies: [],
    resourceClaims: [],
    remainingWork: ["Run regression tests"],
    importantDecisions: [],
    createdAt: now,
  };
  const hash = capsuleHash(capsule);
  assert.equal(hash.length, 64);
  const receipt = handoffReceipt(capsule, "claude-session", "codex-session", now + 1);
  assert.equal(receipt.taskId, "task");
  assert.equal(receipt.capsuleHash, hash);
  assert.equal(receipt.sourceSessionId, "claude-session");
  assert.equal(receipt.targetSessionId, "codex-session");
});

test("store rejects an accepted handoff receipt for a different capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-receipt-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  const capsule = {
    taskId: "task", goal: "Run tests", currentStatus: "Ready",
    sourceProvider: "claude" as const, sourceComputer: "mac",
    targetProvider: "codex" as const, targetComputer: "pc",
    repository: "github.com/example/repo", baseSha: "a".repeat(40),
    filesChanged: [], dependencies: [], resourceClaims: [], remainingWork: ["Test"],
    importantDecisions: [], createdAt: now,
  };
  assert.equal(store.acceptEvent({
    type: "mesh.event", sessionId: "task", eventId: "request", projectId: "project",
    taskId: "task", sourceSessionId: "claude", eventType: "HANDOFF_REQUEST",
    createdAt: now, payload: { capsule },
  }), true);
  const receipt = handoffReceipt(capsule, "claude", "codex", now + 1);
  assert.equal(store.acceptEvent({
    type: "mesh.event", sessionId: "task", eventId: "accepted", projectId: "project",
    taskId: "task", sourceSessionId: "codex", targetSessionId: "claude",
    eventType: "HANDOFF_ACCEPTED", createdAt: now + 1,
    payload: { receipt: { ...receipt, capsuleHash: "0".repeat(64) } },
  }), false);
  assert.equal(store.acceptEvent({
    type: "mesh.event", sessionId: "task", eventId: "accepted-valid", projectId: "project",
    taskId: "task", sourceSessionId: "codex", targetSessionId: "claude",
    eventType: "HANDOFF_ACCEPTED", createdAt: now + 1, payload: { receipt },
  }), true);
});

test("catalog groups sessions by repository and preserves task identity on handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-catalog-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  const sessions = linkSessionsToProjects(store, [
    {
      sessionId: "claude-native",
      agent: "claude",
      title: "Pairing refactor",
      cwd: "/repo",
      branch: "claude/pairing",
      state: "working",
      startedAt: now - 1_000,
      lastActivityAt: now,
      tokensSession: 10,
      tokensLastTurn: 2,
    },
  ], "mac", () => ({
    root: "/repo",
    canonicalRepositoryId: "github.com/example/granttap",
    baseRemote: "https://oauth2:TOKEN@github.com/example/granttap.git?ref=main",
    worktree: "/repo",
  }));
  const source = sessions[0]!;
  assert.ok(source.projectId);
  assert.ok(source.taskId);
  store.linkExecution({
    taskId: source.taskId!,
    sessionId: "codex-native",
    provider: "codex",
    computerId: "workstation",
    workspace: "/repo-tests",
    branch: "codex/regression",
    worktree: "/repo-tests",
    startedAt: now + 1,
  });
  const snapshot = store.snapshot(source.projectId!);
  assert.equal(snapshot?.project.baseRemote, "github.com/example/granttap");
  assert.doesNotMatch(JSON.stringify(snapshot), /TOKEN|oauth2|ref=main/);
  assert.equal(snapshot?.tasks.length, 1);
  assert.equal(snapshot?.executions.length, 2);
  assert.deepEqual(new Set(snapshot?.executions.map((item) => item.taskId)), new Set([source.taskId]));
});

test("catalog honors existing multi-repository logical Project bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-logical-project-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "applydjinn", name: "ApplyDjinn",
    canonicalRepositoryId: "github.com/example/frontend", createdAt: now,
  });
  for (const [bindingId, repositoryId] of ([
    ["frontend-binding", "github.com/example/frontend"],
    ["api-binding", "github.com/example/api"],
  ] as const)) {
    store.upsertBinding({
      bindingId, projectId: "applydjinn", endpointId: "mac", repositoryId,
      displayName: repositoryId.split("/").at(-1)!, available: true,
    });
  }
  const sessions = linkSessionsToProjects(store, [
    session("frontend-session", "/frontend"),
    session("api-session", "/api"),
  ], "mac", (cwd) => ({
    root: cwd,
    canonicalRepositoryId: `github.com/example/${cwd.slice(1)}`,
    worktree: cwd,
  }));
  assert.deepEqual(new Set(sessions.map((item) => item.projectId)), new Set(["applydjinn"]));
  assert.equal(store.snapshot("applydjinn")?.bindings?.length, 2);
});

function session(sessionId: string, cwd: string) {
  return {
    sessionId, agent: "codex", cwd, state: "working" as const,
    startedAt: now, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0,
  };
}

test("local handoff capsule contains explicit git facts but no transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-capsule-"));
  const state = await mkdtemp(join(tmpdir(), "granttap-mesh-state-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "initial\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "-q", "-m", "initial"]);
  await writeFile(join(root, "README.md"), "changed\n");
  const store = new MeshStore(join(state, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "project", name: "repo", repositoryRoot: root,
    canonicalRepositoryId: "github.com/example/repo", createdAt: now,
  });
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "handoff", ownerSessionId: "claude-native", createdAt: now, updatedAt: now,
  });
  const capsule = buildTaskCapsule(store, {
    sessionId: "claude-native", agent: "claude", projectId: "project", taskId: "task",
    cwd: root, state: "idle", startedAt: now, lastActivityAt: now,
    tokensSession: 0, tokensLastTurn: 0,
  }, {
    type: "mesh.handoff.prepare", sessionId: "claude-native", projectId: "project",
    taskId: "task", targetProvider: "codex", targetComputer: "workstation", createdAt: now,
  }, "mac");
  assert.ok(capsule);
  assert.equal(capsule.repository, "github.com/example/repo");
  assert.deepEqual(capsule.filesChanged, ["README.md"]);
  assert.equal(capsule.dirtyDiffHash?.length, 64);
  assert.doesNotMatch(JSON.stringify(capsule), /transcript|reasoning|chain.of.thought/i);
});

test("handoff creates a separate branch and worktree before target execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-worktree-"));
  const worktrees = await mkdtemp(join(tmpdir(), "granttap-mesh-worktrees-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "file.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "-q", "-m", "base"]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const created = createHandoffWorktree(root, worktrees, "task-123", "codex", sha, now);
  assert.ok(created);
  assert.notEqual(created.path, root);
  assert.match(created.branch, /^granttap\/codex\/task-123-/);
  assert.equal(execFileSync("git", ["-C", created.path, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(), sha);
  assert.equal(createHandoffWorktree(root, worktrees, "task-123", "codex", sha, now), undefined);
  assert.equal(createHandoffWorktree("/missing/repo", worktrees, "broken", "codex", sha, now), undefined);
});
