import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshStore } from "../../../../../bridge/src/mesh/store";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { desktopLiveCatalog } from "../index";

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), "granttap-live-catalog-")), "mesh.json");
  const store = new MeshStore(path, () => 100);
  store.upsertProject({ projectId: "p", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 });
  store.upsertTask({ taskId: "t", projectId: "p", title: "Test", goal: "Earlier result",
    state: "working", ownerSessionId: "s", createdAt: 1, updatedAt: 90 });
  store.linkExecution({ taskId: "t", sessionId: "s", provider: "codex", computerId: "local",
    workspace: "/repo", startedAt: 1, activeAt: 50, endedAt: 60 });
  const session: SessionInfo = { sessionId: "s", agent: "codex", state: "working",
    cwd: "/repo", summary: "Current progress", startedAt: 1, lastActivityAt: 90,
    tokensSession: 5, tokensLastTurn: 1 };
  return { path, store, session };
}

test("live native work supersedes a stale close in the current chat without rewriting Mesh history", async () => {
  const f = await fixture();
  const before = await readFile(f.path, "utf8");
  const result = desktopLiveCatalog(f.path, "local", [f.session], 100);
  assert.equal(result?.sessions[0]?.state, "working");
  assert.equal(result?.sessions[0]?.taskId, "t");
  assert.equal(result?.sessions[0]?.projectId, "p");
  assert.equal(result?.sessions[0]?.summary, "Current progress");
  assert.equal(await readFile(f.path, "utf8"), before);
});

test("another computer, provider, or a handed-off owner cannot claim the current Task", async () => {
  const f = await fixture();
  assert.deepEqual(desktopLiveCatalog(f.path, "remote", [f.session], 100)?.sessions, []);
  assert.deepEqual(desktopLiveCatalog(f.path, "local", [{ ...f.session, agent: "claude" }], 100)?.sessions, []);
  f.store.upsertTask({ taskId: "t", projectId: "p", title: "Test", goal: "Moved",
    state: "working", ownerSessionId: "new", createdAt: 1, updatedAt: 110 });
  assert.deepEqual(desktopLiveCatalog(f.path, "local", [f.session], 120)?.sessions, []);
});

test("an explicit completed Task is not reopened by native activity", async () => {
  const f = await fixture();
  f.store.upsertTask({ taskId: "t", projectId: "p", title: "Test", goal: "Done",
    state: "completed", ownerSessionId: "s", createdAt: 1, updatedAt: 110 });
  assert.deepEqual(desktopLiveCatalog(f.path, "local", [f.session], 120)?.sessions, []);
});

test("an idle report keeps the actual native state and empty or missing catalogs remain bounded", async () => {
  const f = await fixture();
  const result = desktopLiveCatalog(f.path, "local", [{ ...f.session, state: "idle" }], 100);
  assert.equal(result?.sessions[0]?.state, "idle");
  assert.equal(desktopLiveCatalog(f.path, "local", [], 100)?.sessions.length, 0);
  assert.equal(desktopLiveCatalog(f.path + ".missing", "local", [f.session], 100)?.sessions.length, 0);
});
