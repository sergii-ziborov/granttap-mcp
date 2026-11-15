import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectBindingSummary, SessionInfo } from "../../../../../../../packages/protocol/schema";
import { inspectRepository, linkSessionsToProjects } from "../../../catalog";
import { MeshStore } from "../..";

process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-repository-store-config-"));
const now = 1_800_000_000_000;

function project(projectId: string) {
  return { projectId, name: `Mesh ${projectId}`, canonicalRepositoryId: `github.com/example/${projectId}`, createdAt: now };
}

function binding(projectId: string, repositoryId: string, endpointId = "mac", extra: Partial<ProjectBindingSummary> = {}) {
  return {
    bindingId: `binding-${projectId}-${endpointId}-${repositoryId}`.replace(/[^a-z0-9-]/gi, "-"),
    projectId, endpointId, repositoryId, displayName: repositoryId, localPathHint: `/work/${repositoryId}`,
    available: true, ...extra,
  };
}

function freshStore() {
  const path = join(mkdtempSync(join(tmpdir(), "granttap-repository-store-")), "mesh.json");
  return { path, store: new MeshStore(path, () => now) };
}

function gitRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-repository-checkout-")));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base"]);
  return root;
}

test("a checkout is bound once per computer, and only to the Mesh it was asked for", () => {
  const { store } = freshStore();
  assert.deepEqual(store.bindRepository(binding("alpha", "app")), { kind: "unknown-mesh" });
  store.upsertProject(project("alpha"));
  store.upsertProject(project("beta"));
  assert.equal(store.bindRepository(binding("alpha", "app")).kind, "bound");
  assert.equal(store.bindRepository(binding("alpha", "app")).kind, "already-bound");
  const elsewhere = store.bindRepository(binding("beta", "app"));
  assert.equal(elsewhere.kind, "bound-elsewhere", "a repository is not moved between Meshes");
  assert.equal(elsewhere.kind === "bound-elsewhere" ? elsewhere.binding.projectId : "", "alpha");
  assert.equal(store.bindRepository(binding("beta", "app", "other-mac")).kind, "bound", "another computer binds its own");
  // A stable id already naming a different binding is refused rather than overwritten.
  store.upsertBinding(binding("beta", "api"));
  assert.deepEqual(store.bindRepository({ ...binding("beta", "api"), repositoryId: "web" }), { kind: "conflict" });
  assert.deepEqual(store.endpointBindings("mac").map((item) => item.repositoryId).sort(), ["api", "app"]);
});

test("a computer removes only its own binding, and never a Mesh's last repository", () => {
  const { store } = freshStore();
  assert.deepEqual(store.unbindRepository("alpha", "nope", "mac"), { kind: "unknown-mesh" });
  store.upsertProject(project("alpha"));
  store.upsertProject(project("beta"));
  const own = binding("alpha", "app");
  store.upsertBinding(own);
  store.upsertBinding(binding("beta", "api"));
  assert.deepEqual(store.unbindRepository("alpha", "nope", "mac"), { kind: "not-found" });
  assert.deepEqual(store.unbindRepository("alpha", binding("beta", "api").bindingId, "mac"), { kind: "not-found" },
    "a binding of another Mesh is not this Mesh's to remove");
  assert.deepEqual(store.unbindRepository("alpha", own.bindingId, "mac"), { kind: "last-repository" });
  const retired = binding("alpha", "old", "Mac.lan", { available: false });
  store.upsertBinding(retired);
  assert.deepEqual(store.unbindRepository("alpha", own.bindingId, "mac"), { kind: "last-repository" },
    "a binding left under a former name is no repository to work in");
  const theirs = binding("alpha", "web", "other-mac");
  store.upsertBinding(theirs);
  assert.equal(store.unbindRepository("alpha", theirs.bindingId, "mac").kind, "not-this-computer");
  store.recordIntegrationPeers("alpha", "app", [{ peer: "github.com/example/api", via: "api", relation: "calls" }]);
  assert.equal(store.unbindRepository("alpha", own.bindingId, "mac").kind, "removed");
  const snapshot = store.snapshot("alpha");
  assert.deepEqual(snapshot?.bindings?.map((item) => item.bindingId).sort(), [retired.bindingId, theirs.bindingId].sort());
  assert.equal(snapshot?.peers, undefined, "what the repository said about its neighbours leaves with it");
  assert.equal(store.bindingRemoved("alpha", "mac", "app"), true);
  assert.equal(store.bindingRemoved("alpha", "other-mac", "app"), false, "the record is this computer's");
});

test("a removed repository stays out through chats in it and snapshots that still list it, until it is added back", () => {
  const { store, path } = freshStore();
  const root = gitRepository();
  const chat: SessionInfo = { sessionId: "chat-1", agent: "codex", cwd: root, state: "idle",
    startedAt: now - 1_000, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0 };
  const [linked] = linkSessionsToProjects(store, [chat], "mac", inspectRepository, []);
  const projectId = linked!.projectId!;
  const repositoryId = inspectRepository(root).canonicalRepositoryId;
  store.upsertBinding(binding(projectId, "web", "other-mac"));
  const before = store.snapshot(projectId)!;
  const own = before.bindings!.find((item) => item.endpointId === "mac")!;
  assert.equal(own.localPathHint, root);
  assert.equal(store.unbindRepository(projectId, own.bindingId, "mac").kind, "removed");

  linkSessionsToProjects(store, [{ ...chat, lastActivityAt: now + 1 }], "mac", inspectRepository, []);
  store.mergeSnapshot(before);
  const after = store.snapshot(projectId)!;
  assert.equal(after.bindings?.some((item) => item.endpointId === "mac"), false, "neither the chat nor the snapshot binds it again");
  assert.equal(after.tasks.length, 1, "the chat's Task stays in the Mesh");
  assert.equal(after.bindings?.length, 1, "another computer's binding in the same snapshot still merges");

  // Another process reading the same file sees the removal, and a binding written back
  // by a writer that does not know of it is not read as bound.
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(disk.removedBindings.map((item: { repositoryId: string }) => item.repositoryId), [repositoryId]);
  writeFileSync(path, JSON.stringify({ ...disk, bindings: [...disk.bindings, own] }));
  const other = new MeshStore(path, () => now);
  assert.equal(other.snapshot(projectId)!.bindings?.some((item) => item.endpointId === "mac"), false);

  assert.equal(other.bindRepository({ ...own, revision: undefined }).kind, "bound", "adding it back forgets the removal");
  assert.equal(other.bindingRemoved(projectId, "mac", repositoryId), false);
  assert.equal(store.snapshot(projectId)!.bindings?.some((item) => item.endpointId === "mac"), true, "the first process sees it back");
  linkSessionsToProjects(store, [{ ...chat, lastActivityAt: now + 2 }], "mac", inspectRepository, []);
  assert.equal(store.snapshot(projectId)!.bindings?.find((item) => item.endpointId === "mac")?.localPathHint, root);
});
