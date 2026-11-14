import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { linkSessionsToProjects, type RepositoryFacts } from "../../catalog";
import { projectIdentity } from "../../identity";
import { MeshStore } from "../../store";
import { createLocalMeshRuntime } from "..";

const now = 1_800_000_000_000;
const RUN = "/private/var/folders/ab/c0ffee123/T/hw-image-1xnbh8ld";
const SCRATCH = "/private/var/folders/ab/c0ffee123/T/granttap-scratch-1";

function freshStore(t: TestContext): MeshStore {
  const root = mkdtempSync(join(tmpdir(), "granttap-helper-mesh-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return new MeshStore(join(root, "mesh.json"), () => now);
}

/** A folder with no Git: the workspace is its own repository identity. */
const withoutGit = (cwd: string): RepositoryFacts => ({ root: cwd, canonicalRepositoryId: `local:${cwd}` });

function session(sessionId: string, cwd: string): SessionInfo {
  return { sessionId, agent: "grok", title: sessionId, cwd, state: "idle", startedAt: now, lastActivityAt: now,
    tokensSession: 0, tokensLastTurn: 0 };
}

/** What a computer carried before helper runs were recognised: one Mesh, Task and execution per run. */
function staleRunMesh(store: MeshStore, folder: string, sessionId: string): string {
  const canonicalRepositoryId = `local:${folder}`;
  const projectId = projectIdentity(canonicalRepositoryId);
  store.upsertProject({ projectId, name: folder.split("/").pop()!, repositoryRoot: folder, canonicalRepositoryId, createdAt: now });
  store.upsertTask({ taskId: `task-${sessionId}`, projectId, title: "A picture", goal: "Continue",
    state: "planned", ownerSessionId: sessionId, createdAt: now, updatedAt: now });
  store.linkExecution({ taskId: `task-${sessionId}`, sessionId, provider: "grok", computerId: "MacBook",
    workspace: folder, startedAt: now });
  return projectId;
}

test("a session in a generator's throwaway folder does not register a Mesh", (t) => {
  const store = freshStore(t);
  const linked = linkSessionsToProjects(store,
    [session("typed-in-such-a-folder", RUN), session("ordinary-temp-chat", SCRATCH)], "MacBook", withoutGit, []);
  assert.deepEqual(linked.map((item) => [item.sessionId, item.projectId != null]),
    [["typed-in-such-a-folder", false], ["ordinary-temp-chat", true]],
    "the chat itself is still listed; only a folder that is not a generator's becomes a workspace Mesh");
  assert.deepEqual(store.projectIds(), [projectIdentity(`local:${SCRATCH}`)]);
});

test("Meshes already registered for helper runs are kept but no longer listed or published", async (t) => {
  const store = freshStore(t);
  const stale = [staleRunMesh(store, RUN, "helper-1"), staleRunMesh(store, "/tmp/hw-image-h3ospkyk", "helper-2")];
  linkSessionsToProjects(store, [session("ordinary-temp-chat", SCRATCH)], "MacBook", withoutGit, []);
  const kept = projectIdentity(`local:${SCRATCH}`);
  assert.deepEqual(store.projectIds(), [kept], "every list of this computer's Meshes leaves them out");
  for (const projectId of stale) {
    assert.equal(store.project(projectId)?.projectId, projectId, "nothing is deleted from the store");
    assert.equal(store.snapshot(projectId)?.tasks.length, 1);
  }
  const runtime = createLocalMeshRuntime({ store: () => store, sessions: () => [], computer: () => "MacBook", now: () => now });
  assert.deepEqual(runtime.snapshots().map((snapshot) => snapshot.projectId), [kept]);
  assert.deepEqual((await runtime.snapshotsAsync([])).map((snapshot) => snapshot.projectId), [kept]);
});
