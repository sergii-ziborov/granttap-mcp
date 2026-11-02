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

test("a chat launched outside any repository belongs to the repository it last changed", t => {
  const dev = realpathSync(mkdtempSync(join(tmpdir(), "granttap-claude-dev-")));
  t.after(() => rmSync(dev, { recursive: true, force: true }));
  const donor = join(dev, "sharprune"), target = join(dev, "pythilo"), later = join(dev, "later");
  for (const path of [donor, target, later]) execFileSync("git", ["init", "-q", path]);
  const edit = (name: string, input: object) => ({ type: "assistant", cwd: donor,
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
  const parse = (rows: object[]) => {
    const file = join(dev, "session.jsonl");
    writeFileSync(file, rows.map((row, index) => JSON.stringify({ ...row, sessionId: "dev-session",
      timestamp: new Date(1_000 + index).toISOString() })).join("\n"));
    return parseClaudeFile(file)!.session;
  };
  const session = parse([
    { type: "user", cwd: dev },
    { type: "assistant", cwd: dev, message: { role: "assistant", content: [
      { type: "tool_use", name: "Bash", input: { command: `cd ${donor} && ls` } }] } },
    edit("Edit", { file_path: join(target, "src", "app.py") }),
    edit("Write", { file_path: join(target, "README.md") }),
    { type: "user", cwd: donor },
  ]);
  assert.equal(session.cwd, donor, "The shell's folder is still reported");
  assert.equal(session.worktree, target);
  const store = new MeshStore(join(dev, "mesh.json"));
  const [linked] = linkSessionsToProjects(store, [session], "mac", inspectRepository, []);
  assert.equal(store.project(linked!.projectId!)?.name, "pythilo");

  assert.equal(parse([{ type: "user", cwd: dev }, edit("Write", { file_path: join(target, "a.md") }),
    edit("NotebookEdit", { notebook_path: join(later, "n.ipynb") })]).worktree, later);
  assert.equal(parse([{ type: "user", cwd: dev }, edit("Write", { file_path: join(target, "a.md") }),
    { type: "assistant", cwd: dev, message: { role: "assistant", content: [{ type: "tool_use",
      name: "Bash", input: { command: `git -C ${later} commit -qm done` } }] } }]).worktree, later);
});

test("a chat launched inside a repository keeps it when files elsewhere change", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-claude-repo-launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const own = join(root, "own"), other = join(root, "other");
  for (const path of [own, other]) execFileSync("git", ["init", "-q", path]);
  const file = join(root, "session.jsonl");
  writeFileSync(file, [
    { type: "user", cwd: join(own, "nested") },
    { type: "assistant", cwd: own, message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: join(other, "x.ts") } }] } },
  ].map((row, index) => JSON.stringify({ ...row, sessionId: "repo-session",
    timestamp: new Date(1_000 + index).toISOString() })).join("\n"));
  const session = parseClaudeFile(file)!.session;
  assert.equal(session.cwd, own);
  assert.equal(session.worktree, undefined);
});
