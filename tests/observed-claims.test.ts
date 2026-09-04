import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { moduleRoot, overlapKind } from "../apps/bridge/src/mesh/store-support";
import {
  clearObservedWrites, recentObservedWrites, recordObservedWrite, writtenPaths,
} from "../apps/bridge/src/mesh/observed-writes";
import { deriveObservedClaims, repositoryRelative } from "../apps/bridge/src/mesh/observed-claims";
import { handoffReadiness } from "../apps/bridge/src/mesh/readiness";

const now = 1_800_000_000_000;

test("a module is recognised from the path alone, the same way everywhere", () => {
  // Shared with the phone's vector test: change one, change both.
  const vectors: Array<[string, string]> = [
    ["apps/ios/GrantTap/Features/ProjectMesh/TaskRouteView.swift", "apps/ios/GrantTap/Features/ProjectMesh"],
    ["apps/bridge/src/mesh/store.ts", "apps/bridge/src/mesh"],
    ["crates/granttap-engine-core/src/backbone.rs", "crates/granttap-engine-core"],
    ["packages/protocol/messages/mesh.ts", "packages/protocol"],
    ["README.md", ""],
    ["docs/product/MARKETING.md", "docs/product"],
  ];
  for (const [path, expected] of vectors) assert.equal(moduleRoot(path), expected, path);

  assert.equal(overlapKind("apps/bridge/src/mesh/store.ts", "apps/bridge/src/mesh/store.ts"), "file");
  assert.equal(overlapKind("apps/bridge/src/mesh/**", "apps/bridge/src/mesh/store.ts"), "file");
  assert.equal(overlapKind("apps/bridge/src/mesh/store.ts", "apps/bridge/src/mesh/catalog.ts"), "module");
  assert.equal(overlapKind("apps/bridge/src/mesh/store.ts", "apps/bridge/src/policy/effective-action.ts"), null);
  assert.equal(overlapKind("README.md", "LICENSE"), null, "top-level files share no module");
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

  recordObservedWrite("chat-a", "/repo/apps/bridge/src/mesh/store.ts", now - 1_000);
  recordObservedWrite("chat-b", "/repo/apps/bridge/src/mesh/catalog.ts", now - 500);
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
    ["intent", "apps/bridge/src/mesh/catalog.ts"], ["intent", "apps/bridge/src/mesh/store.ts"],
  ]);
  // Re-deriving the same moment changes nothing; a later write extends it.
  assert.equal(deriveObservedClaims(store, sessions, now, () => ({ root: "/repo" })), 0);
  recordObservedWrite("chat-a", "/repo/apps/bridge/src/mesh/store.ts", now + 5_000);
  assert.equal(deriveObservedClaims(store, sessions, now + 5_000, () => ({ root: "/repo" })), 1);

  // Same module, different file: a warning on the handoff, not a refusal.
  assert.equal(store.conflicts("project", "chat-a", "apps/bridge/src/mesh/store.ts").length, 0);
  assert.equal(store.moduleOverlaps("project", "chat-a", "apps/bridge/src/mesh/store.ts").length, 1);
  const readiness = handoffReadiness({
    capsule: undefined, targetProviderEnabled: true, conflicts: [],
    moduleOverlaps: store.moduleOverlaps("project", "chat-a", "apps/bridge/src/mesh/store.ts"),
  });
  assert.equal(readiness.warnings.length, 1);
  assert.match(readiness.warnings[0]!, /chat-b is working in the same module/);

  assert.equal(repositoryRelative("/repo/a/b.ts", "/repo"), "a/b.ts");
  assert.equal(repositoryRelative("a/b.ts", "/repo"), "a/b.ts");
  assert.equal(repositoryRelative("/other/b.ts", "/repo"), undefined);
});
