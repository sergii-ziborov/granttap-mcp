import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { linkSessionsToProjects, type RepositoryFacts } from "../../catalog";
import { projectBindingIdentity, projectIdentity } from "../../identity";
import { addMeshRepository } from "../../repositories/edit";
import { MeshStore } from "../../store";
import { folderMeshHoldsRemote, supersedingProject } from "../folder-meshes";

const remote = "github.com/owner/versemora";
const now = 1_800_000_000_000;

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-folder-meshes-")));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const dev = join(root, "dev"), app = join(dev, "versemora");
  mkdirSync(app, { recursive: true });
  // `~/dev` has no Git; `~/dev/versemora` is a clone with its own remote.
  const inspect = (cwd: string): RepositoryFacts => cwd.startsWith(app)
    ? { root: app, worktree: app, canonicalRepositoryId: remote, baseRemote: `https://${remote}.git`, revision: "a".repeat(40) }
    : { root: cwd, canonicalRepositoryId: `local:${cwd}` };
  let clock = now;
  const store = new MeshStore(join(root, "mesh.json"), () => clock++);
  const chat = (sessionId: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, agent: "claude", cwd,
    state: "working", startedAt: now, lastActivityAt: now + 1, tokensSession: 0, tokensLastTurn: 0, ...extra });
  const link = (...sessions: SessionInfo[]) => linkSessionsToProjects(store, sessions, "mac", inspect, []);
  return { root, dev, app, store, chat, link, devProject: projectIdentity(`local:${dev}`), ownProject: projectIdentity(remote) };
}

test("a task begun in a folder without Git that works in a repository with a remote leaves that repository its own Mesh", t => {
  const f = fixture(t);
  const started = f.link(f.chat("parent-chat", f.dev))[0]!;
  assert.equal(started.projectId, f.devProject);
  const working = f.link(f.chat("parent-chat", f.dev, { worktree: f.app, lastActivityAt: now + 60_000 }))[0]!;
  assert.equal(working.projectId, f.devProject, "the task stays in the folder Mesh it began in");
  assert.equal(working.taskId, started.taskId);
  const dev = f.store.snapshot(f.devProject)!;
  assert.deepEqual(dev.bindings?.map((binding) => binding.repositoryId), [`local:${f.dev}`],
    "the folder Mesh does not take the repository");
  assert.equal(dev.executions.find((row) => row.sessionId === "parent-chat")?.repositoryId, remote,
    "where the task worked is still recorded on its execution");
  const fresh = f.link(f.chat("new-chat", f.app))[0]!;
  assert.equal(fresh.projectId, f.ownProject, "a new chat in the repository goes to the repository's own Mesh");
  assert.deepEqual(f.store.snapshot(f.ownProject)?.bindings?.map((binding) => [binding.repositoryId, binding.localPathHint]),
    [[remote, f.app]]);
});

test("a binding an older runtime made stops routing at once and moves to the repository's Mesh with its next chat", t => {
  const f = fixture(t);
  f.link(f.chat("parent-chat", f.dev));
  const stale = { bindingId: projectBindingIdentity(f.devProject, "mac", remote), projectId: f.devProject, endpointId: "mac",
    repositoryId: remote, displayName: "versemora", localPathHint: f.app, available: true };
  f.store.upsertBinding(stale);
  f.store.upsertBinding({ ...stale, bindingId: projectBindingIdentity(f.devProject, "other-mac", remote), endpointId: "other-mac" });
  const echo = f.store.snapshot(f.devProject)!;
  assert.equal(f.store.projectIdForRepository(remote, "mac"), undefined, "the folder Mesh's binding routes nothing");
  assert.equal(f.store.projectIdForRepository(remote), undefined, "nor does another computer's");
  const earlier = f.link(f.chat("parent-chat", f.dev, { worktree: f.app }))[0]!;
  assert.equal(earlier.projectId, f.devProject, "existing task history stays where it is");
  assert.equal(f.store.snapshot(f.devProject)?.bindings?.some((binding) => binding.endpointId === "mac" && binding.repositoryId === remote),
    false, "this computer's binding left the folder Mesh");
  assert.equal(f.store.bindingRemoved(f.devProject, "mac", remote), true);
  const fresh = f.link(f.chat("new-chat", f.app))[0]!;
  assert.equal(fresh.projectId, f.ownProject);
  assert.equal(f.store.bindingForEndpoint(remote, "mac")?.projectId, f.ownProject);
  f.store.mergeSnapshot(echo);
  assert.equal(f.store.bindingForEndpoint(remote, "mac")?.projectId, f.ownProject,
    "a snapshot that still lists the old binding does not bring it back");
  assert.equal(f.store.projectIdForRepository(remote, "mac"), f.ownProject);
  assert.equal(f.store.releaseFromFolderMesh("mac", remote), undefined, "a repository's own Mesh keeps it");
});

test("the phone cannot add a repository with its own remote to a folder Mesh", async t => {
  const f = fixture(t);
  f.link(f.chat("parent-chat", f.dev));
  const inspect = async (cwd: string): Promise<RepositoryFacts> => ({ root: f.app, worktree: f.app, canonicalRepositoryId: remote,
    revision: "b".repeat(40), ...(cwd ? {} : {}) });
  const refused = await addMeshRepository(f.store, { type: "mesh.repository.edit", requestId: "edit-1", sessionId: f.devProject,
    projectId: f.devProject, action: "add", path: f.app, createdAt: now } as never, "mac", inspect);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid");
  assert.match(refused.detail ?? "", /has its own remote/);
  assert.equal(f.store.bindingForEndpoint(remote, "mac"), undefined);
});

test("a folder Mesh whose folder became a clone of a repository with its own Mesh is published as superseded", t => {
  const f = fixture(t);
  const folder = join(f.root, "ivrit-inbox"), tellwick = "github.com/owner/tellwick";
  mkdirSync(folder);
  let cloned = false;
  const inspect = (cwd: string): RepositoryFacts => cloned
    ? { root: folder, worktree: folder, canonicalRepositoryId: tellwick, revision: "c".repeat(40) }
    : { root: cwd, canonicalRepositoryId: `local:${cwd}` };
  const link = (...sessions: SessionInfo[]) => linkSessionsToProjects(f.store, sessions, "mac", inspect, []);
  const old = link(f.chat("old-chat", folder))[0]!;
  const twin = old.projectId!;
  assert.equal(f.store.snapshot(twin)?.project.supersededBy, undefined, "a plain folder's Mesh is its own");
  cloned = true;
  mkdirSync(join(folder, ".git"));
  const moved = link(f.chat("old-chat", folder), f.chat("new-chat", folder));
  assert.equal(moved[0]!.projectId, twin, "the old chat keeps its Mesh and its history");
  assert.equal(moved[1]!.projectId, projectIdentity(tellwick), "a new chat goes to the repository's Mesh");
  const published = f.store.snapshot(twin)!;
  assert.equal(published.project.supersededBy, projectIdentity(tellwick));
  assert.equal(f.store.snapshot(twin, "mac")?.project.supersededBy, projectIdentity(tellwick));
  assert.equal(f.store.snapshot(twin, "another-mac")?.project.supersededBy, undefined,
    "another computer's chats in a folder of the same name are not read from this disk");
  assert.equal(published.tasks.length, 1, "its tasks are still published");
  assert.equal(f.store.snapshot(projectIdentity(tellwick))?.project.supersededBy, undefined);
  assert.equal(f.store.snapshot(f.devProject), undefined);
  f.store.mergeSnapshot(published);
  assert.equal(f.store.project(twin)?.supersededBy, undefined, "the mark is read from this computer's folders, never stored");
  rmSync(join(folder, ".git"), { recursive: true });
  assert.equal(f.store.snapshot(twin)?.project.supersededBy, undefined, "a folder that is plain again is its Mesh's again");
});

test("only a folder Mesh is passed over, and only for a repository with a remote", () => {
  assert.equal(folderMeshHoldsRemote({ canonicalRepositoryId: "local:/x/dev" }, remote), true);
  assert.equal(folderMeshHoldsRemote({ canonicalRepositoryId: "local:/x/dev" }, "local:/x/dev/lad"), false,
    "a local repository without a remote may still join the folder's Mesh");
  assert.equal(folderMeshHoldsRemote({ canonicalRepositoryId: remote }, "github.com/owner/other"), false,
    "a repository Mesh can bind several repositories");
  assert.equal(folderMeshHoldsRemote(undefined, remote), false);
  const project = { projectId: "project-folder", name: "x", canonicalRepositoryId: "local:/x", createdAt: 1 };
  assert.equal(supersedingProject(project, { projects: [], tasks: [], executions: [] }, () => true), undefined,
    "no chat runs there in another Mesh yet");
  assert.equal(supersedingProject({ ...project, canonicalRepositoryId: remote }, { projects: [], tasks: [], executions: [] }),
    undefined);
});
