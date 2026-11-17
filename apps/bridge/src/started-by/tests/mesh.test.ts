import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { linkSessionsToProjects, type RepositoryFacts } from "../../mesh/catalog";
import { projectIdentity } from "../../mesh/identity";
import { MeshStore } from "../../mesh/store";
import { rememberStartedLinks } from "../links";
import { forgetCheckoutChecks } from "../mesh";

const now = 1_800_000_000_000;
const COMPUTER = "MacBook";
const APP = "/Users/someone/dev/applydjin";
const REMOTE = "github.com/someone/applydjin";
const PARENT = "38034755-03a1-429d-8db6-2aa351e64a0b";

function freshStore(t: TestContext): { store: MeshStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "granttap-started-mesh-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  forgetCheckoutChecks();
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { store: new MeshStore(join(root, "mesh.json"), () => now), root };
}

/** The parent's checkout has a remote; a folder outside it has no Git; `own` is a checkout of its own. */
function inspector(own: Record<string, string> = {}) {
  return (cwd: string): RepositoryFacts => {
    if (cwd.startsWith(APP)) return { root: APP, canonicalRepositoryId: REMOTE, baseRemote: `https://${REMOTE}.git`, worktree: APP, revision: "a".repeat(40) };
    const remote = Object.entries(own).find(([folder]) => cwd.startsWith(folder));
    if (remote) return { root: remote[0], canonicalRepositoryId: remote[1], worktree: remote[0], revision: "b".repeat(40) };
    return { root: cwd, canonicalRepositoryId: `local:${cwd}` };
  };
}

function session(sessionId: string, agent: string, cwd: string, startedBy?: SessionInfo["startedBy"], offset = 0): SessionInfo {
  return { sessionId, agent, title: sessionId, cwd, state: "idle", startedAt: now + offset, lastActivityAt: now + offset + 1_000,
    tokensSession: 0, tokensLastTurn: 0, ...(startedBy ? { startedBy } : {}) };
}

const byParent = { agent: "claude" as const, sessionId: PARENT };

test("a child in a folder that is no checkout of its own goes to its parent's Mesh and registers none", (t) => {
  const { store } = freshStore(t);
  const linked = linkSessionsToProjects(store, [
    session("01a1e72d-3cd3-7ea0-854d-252ca5443461", "codex", "/tmp/blogart", byParent, 60_000),
    session("01a1e72e-e724-7e42-b71b-646abde999a3", "codex", `${APP}/build/art`, byParent, 70_000),
    session("grandchild-of-applydjin-01", "claude", "/tmp/blogart/sub", { agent: "codex", sessionId: "01a1e72d-3cd3-7ea0-854d-252ca5443461" }, 80_000),
    session(PARENT, "claude", APP),
  ], COMPUTER, inspector(), []);
  const parentProject = projectIdentity(REMOTE);
  assert.deepEqual(linked.map((item) => [item.sessionId, item.projectId]), [
    ["01a1e72d-3cd3-7ea0-854d-252ca5443461", parentProject],
    ["01a1e72e-e724-7e42-b71b-646abde999a3", parentProject],
    ["grandchild-of-applydjin-01", parentProject],
    [PARENT, parentProject],
  ], "the list keeps its order; a child before its parent still follows it");
  assert.deepEqual(linked.map((item) => item.startedBy?.sessionId), [PARENT, PARENT, "01a1e72d-3cd3-7ea0-854d-252ca5443461", undefined]);
  assert.deepEqual(store.projectIds(), [parentProject], "no Mesh for /tmp/blogart");
  const snapshot = store.snapshot(parentProject)!;
  assert.equal(snapshot.tasks.length, 4, "each child is a Task of its own in the parent's Mesh");
  const execution = snapshot.executions.find((item) => item.sessionId === "01a1e72d-3cd3-7ea0-854d-252ca5443461")!;
  assert.deepEqual([execution.workspace, execution.repositoryId], ["/tmp/blogart", REMOTE]);
});

test("a child whose parent this computer does not know registers no Mesh; one in a checkout of its own keeps its Mesh", (t) => {
  const { store } = freshStore(t);
  const linked = linkSessionsToProjects(store, [
    session("orphan-child-000001", "codex", "/tmp/blogart", { agent: "claude", sessionId: "a-chat-on-another-mac" }),
    session("worktree-child-0001", "codex", "/Users/someone/dev/site", byParent),
    session(PARENT, "claude", APP),
  ], COMPUTER, inspector({ "/Users/someone/dev/site": "github.com/someone/site" }), []);
  assert.deepEqual(linked.map((item) => [item.sessionId, item.projectId, item.startedBy?.sessionId]), [
    ["orphan-child-000001", undefined, "a-chat-on-another-mac"],
    ["worktree-child-0001", projectIdentity("github.com/someone/site"), PARENT],
    [PARENT, projectIdentity(REMOTE), undefined],
  ], "the phone still learns who started each child");
  assert.deepEqual(store.projectIds().sort(), [projectIdentity(REMOTE), projectIdentity("github.com/someone/site")].sort());
});

test("a child follows a parent placed by an earlier catalog, and leaves a Mesh an older runtime made for its folder", (t) => {
  const { store, root } = freshStore(t);
  const child = "01a1e730-5e03-7140-944e-977f7e0a3c8d";
  const blogart = join(root, "blogart");
  mkdirSync(blogart);
  // What an older runtime did: the child got a Mesh of its folder.
  linkSessionsToProjects(store, [session(PARENT, "claude", APP), session(child, "codex", blogart, undefined, 60_000)],
    COMPUTER, inspector(), []);
  const junk = projectIdentity(`local:${blogart}`);
  assert.deepEqual(store.projectIds().sort(), [projectIdentity(REMOTE), junk].sort());
  rememberStartedLinks([{ agent: "codex", sessionId: child, parent: byParent, source: "transcript", at: now }], [], now);
  const [moved] = linkSessionsToProjects(store, [session(child, "codex", blogart, byParent, 60_000)], COMPUTER, inspector(), []);
  assert.equal(moved?.projectId, projectIdentity(REMOTE));
  assert.equal(store.taskForExecution(COMPUTER, "codex", child), moved?.taskId);
  assert.deepEqual(store.projectIds(), [projectIdentity(REMOTE)], "the folder's Mesh holds only a started chat: it is not listed");
  assert.equal(store.project(junk)?.projectId, junk, "nothing is deleted from the store");
});

test("a Mesh of a plain folder stays listed while a chat of its own works there, or when the folder is a checkout", (t) => {
  const { store, root } = freshStore(t);
  const plain = join(root, "notes");
  const checkout = join(root, "local-repo");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(plain);
  for (const [folder, id] of [[plain, "started-in-notes-01"], [checkout, "started-in-repo-01"]] as const) {
    const projectId = projectIdentity(`local:${folder}`);
    store.upsertProject({ projectId, name: "folder", repositoryRoot: folder, canonicalRepositoryId: `local:${folder}`, createdAt: now });
    store.upsertTask({ taskId: `task-${id}`, projectId, title: "Run", goal: "Continue", state: "planned", ownerSessionId: id, createdAt: now, updatedAt: now });
    store.linkExecution({ taskId: `task-${id}`, sessionId: id, provider: "codex", computerId: COMPUTER, workspace: folder, startedAt: now });
  }
  rememberStartedLinks(["started-in-notes-01", "started-in-repo-01"].map((sessionId) =>
    ({ agent: "codex" as const, sessionId, parent: byParent, source: "process" as const, at: now })), [], now);
  assert.deepEqual(store.projectIds(), [projectIdentity(`local:${checkout}`)], "a checkout of its own keeps its Mesh");
  const notes = projectIdentity(`local:${plain}`);
  store.upsertTask({ taskId: "task-person", projectId: notes, title: "Mine", goal: "Continue", state: "planned",
    ownerSessionId: "typed-by-the-person", createdAt: now, updatedAt: now });
  assert.deepEqual(store.projectIds().sort(), [notes, projectIdentity(`local:${checkout}`)].sort(),
    "a chat nobody started works there too");
});
