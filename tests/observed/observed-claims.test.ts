import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshStore } from "../../apps/bridge/src/mesh/store";
import { moduleRoot, overlapKind, resourceOverlap } from "../../apps/bridge/src/mesh/store/support";
import {
  clearObservedWrites, recentObservedWrites, recordObservedWrite, writtenPaths,
} from "../../apps/bridge/src/mesh/observed/writes";
import { deriveObservedClaims, repositoryRelative } from "../../apps/bridge/src/mesh/observed/claims";
import { scopedNeighbours } from "../../apps/bridge/src/mesh/snapshot/scoped-view";
import { handoffReadiness } from "../../apps/bridge/src/mesh/tasks/readiness";

const now = 1_800_000_000_000;

test("a module is recognised from the path alone, the same way everywhere", () => {
  // Shared with the phone's vector test: change one, change both.
  const vectors: Array<[string, string]> = [
    ["apps/ios/GrantTap/Features/ProjectMesh/TaskRouteView.swift", "apps/ios/GrantTap/Features/ProjectMesh"],
    ["apps/bridge/src/mesh/store/index.ts", "apps/bridge/src/mesh"],
    ["crates/granttap-engine-core/src/backbone.rs", "crates/granttap-engine-core"],
    ["packages/protocol/messages/mesh/index.ts", "packages/protocol"],
    ["README.md", ""],
    ["docs/product/MARKETING.md", "docs/product"],
  ];
  for (const [path, expected] of vectors) assert.equal(moduleRoot(path), expected, path);

  assert.equal(overlapKind("apps/bridge/src/mesh/store/index.ts", "apps/bridge/src/mesh/store/index.ts"), "file");
  assert.equal(overlapKind("apps/bridge/src/mesh/**", "apps/bridge/src/mesh/store/index.ts"), "file");
  assert.equal(overlapKind("apps/bridge/src/mesh/store/index.ts", "apps/bridge/src/mesh/catalog/index.ts"), "module");
  assert.equal(overlapKind("apps/bridge/src/mesh/store/index.ts", "apps/bridge/src/policy/effective-action.ts"), null);
  assert.equal(overlapKind("README.md", "LICENSE"), null, "top-level files share no module");
});

test("resource overlap respects path segments and glob boundaries", () => {
  for (const [left, right] of ([
    ["src/auth.ts", "src/auth.ts.bak"],
    ["src/auth", "src/author/index.ts"],
    ["src/auth/*", "src/authentication/file.ts"],
    ["src/auth/**", "src/authentication/file.ts"],
  ] as const)) assert.equal(resourceOverlap(left, right), false, `${left} <> ${right}`);
  assert.equal(resourceOverlap("src/auth", "src/auth/index.ts"), true);
  assert.equal(resourceOverlap("src/auth/**", "src/auth/index.ts"), true);
  assert.equal(resourceOverlap("src\\auth\\index.ts", "src/auth/index.ts"), true);
});

test("same relative path in separate Project repositories is not one file", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claims-repositories-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.claim({
    claimId: "frontend-write", projectId: "project", taskId: "frontend-task",
    ownerSessionId: "frontend-agent", repositoryId: "github.com/example/frontend",
    resource: "src/index.ts", mode: "intent", createdAt: now,
    expiresAt: now + 60_000,
  });
  assert.equal(store.conflicts("project", "backend-agent", "src/index.ts", {
    repositoryId: "github.com/example/backend",
  }).length, 0);
  assert.equal(store.conflicts("project", "other-frontend-agent", "src/index.ts", {
    repositoryId: "github.com/example/frontend",
  }).length, 1);
  store.claim({
    claimId: "backend-write", projectId: "project", taskId: "backend-task",
    ownerSessionId: "backend-agent", repositoryId: "github.com/example/backend",
    resource: "src/index.ts", mode: "intent", createdAt: now,
    expiresAt: now + 60_000,
  });
  assert.deepEqual(scopedNeighbours({ claims: store.activeClaims() }, "frontend-task"), []);
});

test("same logical path in another checkout is a warning, not a shared-file conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claims-worktrees-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.claim({
    claimId: "checkout-a", projectId: "project", taskId: "task-a",
    ownerSessionId: "agent-a", repositoryId: "github.com/example/repo",
    endpointId: "mac", worktree: "/repo/worktrees/a", resource: "src/index.ts",
    mode: "intent", createdAt: now, expiresAt: now + 60_000,
  });
  const scope = { repositoryId: "github.com/example/repo", endpointId: "mac", worktree: "/repo/worktrees/b" };
  assert.equal(store.conflicts("project", "agent-b", "src/index.ts", scope).length, 0);
  assert.equal(store.moduleOverlaps("project", "agent-b", "src/index.ts", scope).length, 1);
  const peer = { ...store.activeClaims()[0]!, claimId: "checkout-b", taskId: "task-b", ownerSessionId: "agent-b", worktree: scope.worktree };
  assert.deepEqual(scopedNeighbours({ claims: [...store.activeClaims(), peer] }, "task-a").map((row) => row.kind), ["logical_file"]);
});

test("a legacy claim without repository identity is uncertainty, not proof of the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claims-legacy-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.claim({ claimId: "legacy", projectId: "project", taskId: "old-task",
    ownerSessionId: "old-agent", resource: "src/index.ts", mode: "intent",
    createdAt: now, expiresAt: now + 60_000 });
  const scope = { repositoryId: "github.com/example/frontend" };
  assert.equal(store.conflicts("project", "new-agent", "src/index.ts", scope).length, 0);
  assert.equal(store.moduleOverlaps("project", "new-agent", "src/index.ts", scope).length, 1);
});

test("edit tools of every provider give up the paths they write", () => {
  assert.deepEqual(writtenPaths("Write", { file_path: "/r/a.ts", content: "x" }), ["/r/a.ts"]);
  assert.deepEqual(writtenPaths("MultiEdit", { file_path: "/r/a.ts", edits: [{ file_path: "/r/b.ts" }] }), ["/r/a.ts", "/r/b.ts"]);
  assert.deepEqual(writtenPaths("NotebookEdit", { notebook_path: "/r/n.ipynb" }), ["/r/n.ipynb"]);
  assert.deepEqual(writtenPaths("edit_file", { target_file: "src/x.swift" }), ["src/x.swift"]);
  assert.deepEqual(
    writtenPaths("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/a.go\n@@\n*** Add File: src/b.go\n*** End Patch" }),
    ["src/a.go", "src/b.go"],
  );
  // Reads, shells, and MCP calls are not writes.
  assert.deepEqual(writtenPaths("Read", { file_path: "/r/a.ts" }), []);
  assert.deepEqual(writtenPaths("Bash", { command: "echo > /r/a.ts" }), []);
  assert.deepEqual(writtenPaths("mcp__github__create_issue", { title: "x" }), []);
});

test("observed writes become intent claims on the Task and warn about the module", async (t) => {
  t.after(clearObservedWrites);
  clearObservedWrites();
  const root = await mkdtemp(join(tmpdir(), "granttap-observed-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask({ taskId: "task-a", projectId: "project", title: "A", goal: "A", state: "working", createdAt: now, updatedAt: now });
  store.upsertTask({ taskId: "task-b", projectId: "project", title: "B", goal: "B", state: "working", createdAt: now, updatedAt: now });

  recordObservedWrite("chat-a", "/repo/apps/bridge/src/mesh/store/index.ts", now - 1_000);
  recordObservedWrite("chat-b", "/repo/apps/bridge/src/mesh/catalog/index.ts", now - 500);
  // A write outside the window is stale, and one outside the repo is nobody's.
  recordObservedWrite("chat-a", "/repo/README.md", now - 11 * 60_000);
  recordObservedWrite("chat-b", "/elsewhere/x.ts", now);
  assert.equal(recentObservedWrites("chat-a", now).length, 1);

  const sessions = [
    { sessionId: "chat-a", agent: "claude", projectId: "project", taskId: "task-a", cwd: "/repo", state: "working" },
    { sessionId: "chat-b", agent: "codex", projectId: "project", taskId: "task-b", cwd: "/repo", state: "working" },
    { sessionId: "chat-c", agent: "claude", cwd: "/repo", state: "working" },
  ] as never;
  const recorded = deriveObservedClaims(store, sessions, now, () => ({ root: "/repo" }));
  assert.equal(recorded, 2, "one intent claim per written file inside the repo");
  const claims = store.snapshot("project")?.claims ?? [];
  assert.deepEqual(claims.map((c) => [c.mode, c.resource]).sort(), [
    ["intent", "apps/bridge/src/mesh/catalog/index.ts"], ["intent", "apps/bridge/src/mesh/store/index.ts"],
  ]);
  // Re-deriving the same moment changes nothing; a later write extends it.
  assert.equal(deriveObservedClaims(store, sessions, now, () => ({ root: "/repo" })), 0);
  recordObservedWrite("chat-a", "/repo/apps/bridge/src/mesh/store/index.ts", now + 5_000);
  assert.equal(deriveObservedClaims(store, sessions, now + 5_000, () => ({ root: "/repo" })), 1);

  // Same module, different file: a warning on the handoff, not a refusal.
  assert.equal(store.conflicts("project", "chat-a", "apps/bridge/src/mesh/store/index.ts").length, 0);
  assert.equal(store.moduleOverlaps("project", "chat-a", "apps/bridge/src/mesh/store/index.ts").length, 1);
  const readiness = handoffReadiness({
    capsule: undefined, targetProviderEnabled: true, conflicts: [],
    moduleOverlaps: store.moduleOverlaps("project", "chat-a", "apps/bridge/src/mesh/store/index.ts"),
  });
  assert.equal(readiness.warnings.length, 1);
  assert.match(readiness.warnings[0]!, /chat-b is working in the same module/);

  assert.equal(repositoryRelative("/repo/a/b.ts", "/repo"), "a/b.ts");
  assert.equal(repositoryRelative("a/b.ts", "/repo"), "a/b.ts");
  assert.equal(repositoryRelative("/other/b.ts", "/repo"), undefined);
});
