import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeFile } from "../parse";
import { inspectRepository, linkSessionsToProjects } from "../../../../mesh/catalog";
import { MeshStore } from "../../../../mesh/store";
import { resolveHandoffSource } from "../../../../mesh/runtime/prepared-transfer/source-binding";

test("Claude's current root conversation folder replaces its original parent workspace", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-current-claude-folder-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), memory = join(root, "memory");
  mkdirSync(memory);
  execFileSync("git", ["init", "-q", repository]);
  const rows = [
    { type: "user", cwd: root },
    { type: "assistant", cwd: repository, gitBranch: "current", message: {
      role: "assistant", content: Array.from({ length: 12 }, (_, index) => ({
        type: "tool_use", name: "Write", input: { file_path: join(memory, `note-${index}.md`) },
      })),
    } },
    { type: "user", cwd: repository, gitBranch: "current" },
  ];
  const file = join(root, "session.jsonl");
  writeFileSync(file, rows.map((row, index) => JSON.stringify({
    ...row, sessionId: "root-session", timestamp: new Date(1_000 + index).toISOString(),
  })).join("\n"));
  const session = parseClaudeFile(file)!.session;
  assert.equal(session.cwd, realpathSync(repository));
  assert.equal(session.branch, "current");
  writeFileSync(join(repository, "README.md"), "Committed fixture\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c",
    "user.email=test@example.test", "commit", "-qm", "base"]);
  const store = new MeshStore(join(root, "mesh.json"));
  const [original] = linkSessionsToProjects(store, [{ ...session, cwd: root }], "mac", inspectRepository, []);
  const [refreshed] = linkSessionsToProjects(store, [session], "mac", inspectRepository, []);
  assert.equal(refreshed!.projectId, original!.projectId, "The stable Project survives a folder change");
  assert.equal(refreshed!.taskId, original!.taskId, "The stable Task survives a folder change");
  assert.equal(refreshed!.worktree, repository);
  const resolved = resolveHandoffSource(store, refreshed!, { type: "mesh.handoff.prepare",
    projectId: refreshed!.projectId!, taskId: refreshed!.taskId!, sessionId: session.sessionId,
    targetProvider: "codex", targetComputer: "mac", createdAt: 1 }, "mac");
  assert.equal(resolved.worktree, repository, "Transfer uses the Task's current verified Git checkout");
});

test("a sidechain's folder and branch cannot replace the root chat's current checkout", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-claude-root-folder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  const child = join(root, "child");
  execFileSync("git", ["init", "-q", child]);
  writeFileSync(file, [
    { type: "user", cwd: root, gitBranch: "old" },
    { type: "user", cwd: join(root, "current"), gitBranch: "current" },
    { type: "assistant", cwd: child, gitBranch: "child", isSidechain: true,
      message: { role: "assistant", content: Array.from({ length: 12 }, () => ({
        type: "tool_use", name: "Bash", input: { command: "pwd", cwd: child },
      })) } },
  ].map((row, index) => JSON.stringify({ ...row, sessionId: "root-session",
    timestamp: new Date(1_000 + index).toISOString() })).join("\n"));
  const session = parseClaudeFile(file)!.session;
  assert.equal(session.cwd, join(root, "current"));
  assert.equal(session.branch, "current");
  assert.equal(session.worktree, undefined);
});
