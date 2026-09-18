import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshSnapshot } from "../packages/protocol/schema";
import { projectSharedSkills } from "../apps/bridge/src/capabilities/skills";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { projectScopedSnapshot, selectSnapshotTasks } from "../apps/bridge/src/mesh/snapshot-window";
import { map, search, status } from "../apps/mcp/src/mcp-tools/mesh-actions";
import { saveGrokBotEndpoint } from "../apps/bridge/src/mesh/endpoint";
import { resetLocalMeshStore, localMeshStore } from "../apps/bridge/src/mesh/local";

const now = 1_800_000_000_000;

function task(id: string, state: "working" | "completed" | "failed", updatedAt: number) {
  return {
    taskId: id, projectId: "project", title: id, goal: id, state,
    ownerSessionId: "claude", createdAt: now, updatedAt,
  };
}

test("an old live task stays in the 64-task window and marks the snapshot incomplete", () => {
  const all = [
    task("old-live", "working", now - 65_000),
    ...Array.from({ length: 64 }, (_, index) => task(`done-${index}`, "completed", now + index)),
  ];
  const { tasks, incomplete } = selectSnapshotTasks(all);
  assert.equal(incomplete, true);
  assert.equal(tasks.length, 64);
  assert.ok(tasks.some((item) => item.taskId === "old-live"));
  assert.equal(tasks.filter((item) => item.state === "completed").length, 63);
});

test("65 tasks keep an old live claim and mark the snapshot incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-65-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: now,
  });
  store.upsertTask(task("old-live", "working", now - 65_000));
  for (let index = 0; index < 64; index += 1) {
    store.upsertTask(task(`done-${index}`, "completed", now + index));
  }
  store.claim({
    claimId: "old-claim", projectId: "project", taskId: "old-live",
    ownerSessionId: "claude", resource: "src/auth.ts", mode: "claim",
    createdAt: now - 65_000, expiresAt: now + 60_000,
  });
  assert.equal(store.acceptEvent({
    type: "mesh.event", sessionId: "old-live", eventId: "old-event",
    projectId: "project", taskId: "old-live", sourceSessionId: "claude",
    eventType: "TASK_PROGRESS", createdAt: now - 64_000,
    payload: { summary: "still working", reason: "needs the old claim" },
  }), true);
  const snapshot = store.snapshot("project");
  assert.equal(snapshot?.incomplete, true);
  assert.equal(snapshot?.tasks.some((item) => item.taskId === "old-live"), true);
  assert.equal(snapshot?.claims.some((item) => item.claimId === "old-claim"), true);
  assert.equal(snapshot?.events.some((item) => item.eventId === "old-event"), true);
});

test("A-only credential status hides task B claims and events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-acl-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetLocalMeshStore();
  t.after(() => {
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
  });
  saveGrokBotEndpoint({
    version: 1,
    endpoint: {
      endpointId: "grok-cloud", kind: "grok_bot_cloud", displayName: "Grok Bot Cloud",
      publicKey: Buffer.alloc(32, 1).toString("base64url"), credentialId: "credential",
      status: "active", createdAt: now,
    },
    credential: {
      credentialId: "credential", endpointId: "grok-cloud", status: "active",
      projectIds: ["project"], taskIds: ["task-a"], operations: ["status", "task"],
      issuedAt: now, expiresAt: now + 86_400_000,
    },
    actors: [{
      actorId: "qa", endpointId: "grok-cloud", kind: "persistent_agent",
      displayName: "QA Bot", status: "idle", enabled: true,
    }],
    pairing: {
      relayUrl: "ws://127.0.0.1:8787", room: "a".repeat(32), role: "machine",
      deviceName: "Grok Bot Cloud", senderId: "bot",
      myPublicKey: Buffer.alloc(32, 1).toString("base64"),
      mySecretKey: Buffer.alloc(32, 2).toString("base64"),
      peerPublicKey: Buffer.alloc(32, 3).toString("base64"),
    },
    policy: {
      type: "mesh.endpoint.policy", endpointId: "grok-cloud", credentialId: "credential",
      enabled: true, status: "active", projectIds: ["project"],
      actors: [{ actorId: "qa", enabled: true }], revision: 1, createdAt: now,
    },
    inviteExpiresAt: now + 600_000,
  });
  const store = localMeshStore();
  store.upsertProject({
    projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: now,
  });
  store.upsertTask(task("task-a", "working", now));
  store.upsertTask({ ...task("task-b", "working", now + 1), projectId: "project" });
  store.claim({
    claimId: "secret-b", projectId: "project", taskId: "task-b",
    ownerSessionId: "claude", resource: "secret/**", mode: "claim",
    createdAt: now, expiresAt: now + 60_000,
  });
  const snapshot = store.snapshot("project");
  const hidden = projectScopedSnapshot(snapshot, ["task-a"]);
  assert.equal(hidden?.tasks.some((item) => item.taskId === "task-b"), false);
  assert.equal(hidden?.claims.some((item) => item.claimId === "secret-b"), false);
  const body = status({ actorId: "qa", projectId: "project" });
  assert.deepEqual(body.tasks.map((item) => item.taskId), ["task-a"]);
  assert.equal(body.claims.some((item) => item.taskId === "task-b"), false);
  assert.doesNotMatch(map({ actorId: "qa", projectId: "project" }), /task-b|secret/);
  const found = search({ actorId: "qa", projectId: "project" }, "secret");
  assert.equal(found.tasks.some((item) => item.taskId === "task-b"), false);
  assert.equal(found.claims.some((item) => item.claimId === "secret-b"), false);
});

test("project skills ride on the snapshot and old snapshots without them still parse", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-skills-"));
  await mkdir(join(root, ".cursor", "skills", "release-check"), { recursive: true });
  await writeFile(join(root, ".cursor", "skills", "release-check", "SKILL.md"), `---
name: release-check
description: Verify a release before publishing.
version: 1.2.0
---
# Release
`);
  const skills = projectSharedSkills([root]);
  assert.equal(skills[0]?.name, "release-check");
  assert.equal(skills[0]?.version, "1.2.0");
  assert.equal(skills[0]?.state, "installed");
  assert.match(skills[0]?.digest ?? "", /^[a-f0-9]{64}$/);
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: root,
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask(task("task", "working", now));
  const snapshot = store.snapshot("project");
  assert.equal(snapshot?.skills?.[0]?.name, "release-check");
  assert.equal(MeshSnapshot.safeParse({
    type: "mesh.snapshot", sessionId: "project", projectId: "project",
    project: snapshot!.project, tasks: snapshot!.tasks, executions: [],
    claims: [], dependencies: [], events: [], generatedAt: now,
  }).success, true);
});

test("a long SKILL.md description is clipped so a mesh snapshot still publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-long-skill-"));
  await mkdir(join(root, ".cursor", "skills", "long-check"), { recursive: true });
  await writeFile(join(root, ".cursor", "skills", "long-check", "SKILL.md"), `---
name: long-check
description: ${"x".repeat(600)}
---
# Long
`);
  const skills = projectSharedSkills([root]);
  assert.equal(skills[0]?.description?.length, 500);
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: root,
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask(task("task", "working", now));
  const snapshot = store.snapshot("project");
  assert.equal(snapshot?.skills?.[0]?.description?.length, 500);
});
