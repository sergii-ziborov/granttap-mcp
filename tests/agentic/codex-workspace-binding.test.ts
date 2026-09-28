import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observedCodexWorktree, workdirsFromCodexCall } from "../../apps/bridge/src/sessions/scan/codex/shared";
import { inspectRepository, linkSessionsToProjects } from "../../apps/bridge/src/mesh/catalog";
import { MeshStore } from "../../apps/bridge/src/mesh/store";
import type { SessionInfo } from "../../packages/protocol/schema";

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "granttap-codex-workspace-"));
  const repo = join(parent, "Lad");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "repo\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c",
    "user.email=test@example.test", "commit", "-q", "-m", "start"]);
  return { parent, repo };
}

test("a workspace first observed without Git is reclassified after repository creation", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-repository-created-"));
  assert.equal(inspectRepository(root).worktree, undefined);
  execFileSync("git", ["init", "-q", root]);
  const fresh = inspectRepository(root);
  assert.equal(fresh.worktree, realpathSync(root));
  assert.equal(fresh.revision, undefined, "an empty Git repository is still a repository");
});

test("repository identity is refreshed when an origin is added after discovery", () => {
  const { repo } = fixture();
  assert.ok(inspectRepository(repo).canonicalRepositoryId.startsWith("local:"));
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.test/owner/app.git"]);
  assert.equal(inspectRepository(repo).canonicalRepositoryId, "example.test/owner/app");
});

test("one catalog snapshot reads consistent Git facts and the next refresh sees new facts", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-catalog-refresh-"));
  const store = new MeshStore(join(root, "mesh.json"), () => 1_800_000_000_000);
  const sessions: SessionInfo[] = ["a", "b"].map((id) => ({
    sessionId: id, agent: "codex", cwd: root, state: "working", startedAt: 1_800_000_000_000,
    lastActivityAt: 1_800_000_001_000, tokensSession: 0, tokensLastTurn: 0,
  }));
  let revision = 0;
  const inspect = () => ({root, worktree: root, canonicalRepositoryId: "example.test/owner/app",
    revision: String(++revision)});
  const first = linkSessionsToProjects(store, sessions, "mac", inspect, []);
  assert.equal(store.snapshot(first[0]!.projectId!)?.bindings?.[0]?.revision, "1");
  const second = linkSessionsToProjects(store, sessions, "mac", inspect, []);
  assert.equal(store.snapshot(first[0]!.projectId!)?.bindings?.[0]?.revision, "2");
  assert.deepEqual(second.map((item) => item.taskId), first.map((item) => item.taskId));
  assert.equal(store.snapshot(first[0]!.projectId!)?.tasks.length, 2);
});

test("Codex tool workdirs identify one verified repository under a non-Git workspace", () => {
  const { parent, repo } = fixture();
  const call = { type: "response_item", payload: { type: "custom_tool_call", name: "exec",
    input: `const result = await tools.exec_command({cmd:"git status",workdir:"${repo}"});` } };
  assert.deepEqual(workdirsFromCodexCall(call), [repo]);
  assert.equal(observedCodexWorktree(parent, [repo, repo, repo]), realpathSync(repo));
  assert.equal(observedCodexWorktree(parent, [repo, repo]), undefined);
  const second = join(parent, "Other");
  mkdirSync(second);
  execFileSync("git", ["init", "-q", second]);
  assert.equal(observedCodexWorktree(parent, [repo, repo, repo, second, second, second]), undefined);
  assert.equal(observedCodexWorktree(repo, [repo, repo, repo]), undefined);
});

test("a discovered Git checkout binds to the existing Task and Project", () => {
  const { parent, repo } = fixture();
  const store = new MeshStore(join(parent, "mesh.json"), () => 1_800_000_000_000);
  const session: SessionInfo = {
    sessionId: "native-codex", agent: "codex", cwd: parent, title: "Build app",
    state: "working", startedAt: 1_800_000_000_000, lastActivityAt: 1_800_000_001_000,
    tokensSession: 0, tokensLastTurn: 0,
  };
  const first = linkSessionsToProjects(store, [session], "mac", inspectRepository, [])[0]!;
  const skill = join(repo, ".agents", "skills", "review");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nReview code.\n");
  const linked = linkSessionsToProjects(store, [{ ...session, worktree: repo }],
    "mac", inspectRepository, [])[0]!;
  assert.equal(linked.taskId, first.taskId);
  assert.equal(linked.projectId, first.projectId);
  const snapshot = store.snapshot(first.projectId!);
  assert.equal(snapshot?.tasks.filter((task) => task.taskId === first.taskId).length, 1);
  assert.ok(snapshot?.bindings?.some((binding) =>
    binding.repositoryId === inspectRepository(repo).canonicalRepositoryId
      && binding.revision === inspectRepository(repo).revision
      && binding.localPathHint === inspectRepository(repo).root));
  assert.ok(snapshot?.executions.some((execution) => execution.taskId === first.taskId
    && execution.repositoryId === inspectRepository(repo).canonicalRepositoryId));
  assert.ok(store.snapshot(first.projectId!, "mac")?.skills?.some((item) =>
    item.name === "review" && item.endpointId === "mac" && item.digest));
});
