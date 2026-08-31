import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshEvent, MeshSnapshot } from "../packages/protocol/schema";
import { handoffReceipt } from "../apps/bridge/src/mesh/handoff";
import { MeshStore } from "../apps/bridge/src/mesh/store";

const now = 1_800_000_000_000;

async function storeAt(initial?: unknown): Promise<MeshStore> {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-store-coverage-"));
  const path = join(root, "mesh.json");
  if (initial !== undefined) await writeFile(path, JSON.stringify(initial));
  return new MeshStore(path, () => now);
}

function project() {
  return {
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
}

function task(state = "planned" as const) {
  return {
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state, ownerSessionId: "claude", createdAt: now, updatedAt: now,
  };
}

function event(id: string, eventType: MeshEvent["eventType"], payload: MeshEvent["payload"]): MeshEvent {
  return {
    type: "mesh.event", sessionId: "task", eventId: id, projectId: "project", taskId: "task",
    sourceSessionId: "claude", eventType, createdAt: now + id.length,
    expiresAt: now + 60_000, payload,
  };
}

test("store loads only valid bounded arrays and preserves older project creation", async () => {
  const store = await storeAt({
    projects: "not-an-array",
    tasks: [task(), { taskId: "invalid" }],
    executions: {}, claims: null, dependencies: [], events: [], receipts: [],
  });
  assert.equal(store.task("task")?.title, "Pairing");
  assert.equal(store.projectIds().length, 0);
  store.upsertProject(project());
  store.upsertProject({ ...project(), name: "Renamed", createdAt: now + 100 });
  assert.equal(store.snapshot("project")?.project.createdAt, now);
  store.upsertTask({ ...task(), title: "Stale", updatedAt: now - 1 });
  store.upsertTask(task());
  assert.equal(store.task("task")?.title, "Pairing");
});

test("claim release is owner-bound and project snapshots prune expired claims", async () => {
  const store = await storeAt();
  store.upsertProject(project());
  store.upsertTask(task());
  store.claim({
    claimId: "claim", projectId: "project", taskId: "task", ownerSessionId: "claude",
    resource: "src/**", mode: "claim", createdAt: now, expiresAt: now + 10,
  });
  assert.equal(store.releaseClaim("claim", "codex"), false);
  assert.equal(store.releaseClaim("claim", "claude"), true);
  assert.equal(store.releaseClaim("missing"), false);
  store.claim({
    claimId: "expired", projectId: "project", taskId: "task", ownerSessionId: "claude",
    resource: "tests/**", mode: "intent", createdAt: now - 10, expiresAt: now - 1,
  });
  assert.deepEqual(store.activeClaims(), []);
});

test("structured events update task, dependency, and resource state", async () => {
  const store = await storeAt();
  store.upsertProject(project());
  store.upsertTask(task());
  store.linkExecution({
    taskId: "task", sessionId: "claude", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "main", startedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "claude", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "main", startedAt: now,
  });
  const claim = {
    claimId: "event-claim", projectId: "project", taskId: "task", ownerSessionId: "claude",
    resource: "src/auth/**", mode: "claim" as const, createdAt: now, expiresAt: now + 60_000,
  };
  assert.equal(store.acceptEvent(event("claim", "RESOURCE_CLAIM", { claim })), true);
  assert.equal(store.acceptEvent(event("dependency", "DEPENDENCY", {
    dependsOnTaskId: "api", summary: "Waiting for API",
  })), true);
  assert.equal(store.snapshot("project")?.dependencies[0]?.dependsOnTaskId, "api");
  assert.equal(store.acceptEvent(event("release", "RESOURCE_RELEASE", { claimId: claim.claimId })), true);
  assert.equal(store.snapshot("project")?.claims.length, 0);
  assert.equal(store.acceptEvent(event("working", "TASK_PROGRESS", { summary: "Working" })), true);
  assert.equal(store.task("task")?.state, "working");
  assert.equal(store.acceptEvent(event("blocked", "TASK_BLOCKED", {
    reason: "Dependency", needsUser: false,
  })), true);
  assert.equal(store.task("task")?.state, "blocked");
  assert.equal(store.acceptEvent(event("human", "TASK_BLOCKED", {
    reason: "Decision", needsUser: true,
  })), true);
  assert.equal(store.task("task")?.state, "needs_user");
  assert.equal(store.acceptEvent(event("conflict", "CONFLICT", {
    resource: "src/auth/**", resolved: false,
  })), true);
  assert.equal(store.acceptEvent(event("rejected", "HANDOFF_REJECTED", {
    reason: "Offline", failed: true,
  })), true);
  assert.equal(store.acceptEvent(event("completed", "TASK_COMPLETED", { summary: "Done" })), true);
  assert.equal(store.task("task")?.state, "completed");
});

test("valid accepted handoff closes the source execution and records its receipt", async () => {
  const store = await storeAt();
  store.upsertProject(project());
  store.upsertTask({ ...task(), state: "handoff" });
  store.linkExecution({
    taskId: "task", sessionId: "claude", provider: "claude", computerId: "MacBook",
    workspace: "/repo", startedAt: now,
  });
  const capsule = {
    taskId: "task", goal: "Finish", currentStatus: "Ready", sourceProvider: "claude" as const,
    sourceComputer: "MacBook", targetProvider: "codex" as const, targetComputer: "Workstation",
    repository: "github.com/example/granttap", baseSha: "a".repeat(40), filesChanged: [],
    dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: now,
  };
  assert.equal(store.acceptEvent(event("request", "HANDOFF_REQUEST", { capsule })), true);
  const receipt = handoffReceipt(capsule, "claude", "codex", now + 20);
  store.recordReceipt(receipt);
  assert.equal(store.acceptEvent({
    ...event("accepted", "HANDOFF_ACCEPTED", { receipt }),
    sourceSessionId: "codex", targetSessionId: "claude",
  }), true);
  const snapshot = store.snapshot("project")!;
  assert.equal(snapshot.tasks[0]?.ownerSessionId, "codex");
  assert.equal(snapshot.executions[0]?.endedAt, receipt.acceptedAt);
});

test("workspace lookup and snapshot merge remain project and computer scoped", async () => {
  const store = await storeAt();
  store.upsertProject(project());
  store.upsertTask(task());
  assert.equal(store.workspaceForRepository(project().canonicalRepositoryId), "/repo");
  assert.equal(store.workspaceForRepository(project().canonicalRepositoryId, "Workstation"), undefined);
  store.linkExecution({
    taskId: "task", sessionId: "codex", provider: "codex", computerId: "Workstation",
    workspace: "/workspace", branch: "tests", worktree: "/worktree", startedAt: now,
  });
  assert.equal(store.workspaceForRepository(project().canonicalRepositoryId), "/worktree");
  assert.equal(store.workspaceForRepository(project().canonicalRepositoryId, "Workstation"), "/worktree");
  assert.equal(store.snapshot("missing"), undefined);

  const incoming: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "project", projectId: "project", project: project(),
    tasks: [{ ...task(), title: "Merged", updatedAt: now + 1 }], executions: [], claims: [],
    dependencies: [], events: [], generatedAt: now + 1,
  };
  const merged = await storeAt();
  merged.mergeSnapshot(incoming);
  assert.equal(merged.task("task")?.title, "Merged");
  assert.deepEqual(merged.projectIds(), ["project"]);
});

test("repository bindings attach several repos and computers to one logical Project", async () => {
  const store = await storeAt();
  store.upsertProject(project());
  store.upsertBinding({
    bindingId: "mac-api", projectId: "project", endpointId: "MacBook",
    repositoryId: "github.com/example/api", displayName: "API", available: true,
    revision: "a".repeat(40),
  });
  store.upsertBinding({
    bindingId: "pc-frontend", projectId: "project", endpointId: "Workstation",
    repositoryId: "github.com/example/frontend", displayName: "Frontend", available: false,
  });
  assert.equal(store.projectIdForRepository("github.com/example/api", "MacBook"), "project");
  assert.equal(store.projectIdForRepository("github.com/example/frontend"), "project");
  assert.deepEqual(
    store.snapshot("project")?.bindings?.map((item) => item.bindingId),
    ["mac-api", "pc-frontend"],
  );
  assert.throws(() => store.upsertBinding({
    bindingId: "mac-api", projectId: "other", endpointId: "Other",
    repositoryId: "other", displayName: "Other", available: true,
  }), /binding conflict/i);
});

test("binding restore and remote merge reject cross-Project identity poisoning", async () => {
  const valid = {
    bindingId: "binding", projectId: "project", endpointId: "MacBook",
    repositoryId: "repo", displayName: "Repo", available: true,
  };
  const restored = await storeAt({
    projects: [project()], bindings: [
      valid,
      { ...valid, bindingId: "duplicate-location" },
      { ...valid, bindingId: "orphan", projectId: "other", endpointId: "Other" },
    ],
  });
  assert.deepEqual(restored.snapshot("project")?.bindings, [valid]);

  const incoming: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: { ...project(), name: "Must not partially merge" },
    bindings: [{
      ...valid, bindingId: "foreign-id", projectId: "project",
    }],
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: now,
  };
  assert.throws(() => restored.mergeSnapshot(incoming), /binding conflict/i);
  assert.equal(restored.snapshot("project")?.project.name, "GrantTap");
});

test("store restore rejects symlinked and oversized coordination state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-store-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify({ projects: [project()] }));
  const linked = join(root, "linked.json");
  await symlink(target, linked);
  assert.deepEqual(new MeshStore(linked).projectIds(), []);

  const oversized = join(root, "oversized.json");
  await writeFile(oversized, Buffer.alloc(4 * 1_024 * 1_024 + 1));
  assert.deepEqual(new MeshStore(oversized).projectIds(), []);
});
