import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { linkSessionsToProjects } from "../../catalog";
import { MeshStore } from "../../store";
import { requestlessTask, selectSnapshotTasks } from "../window";

const inspect = (cwd: string) => ({ root: cwd, worktree: cwd, canonicalRepositoryId: "example.test/owner/app" });
const chat = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, agent: "codex", cwd: "/work/app",
  state: "idle", startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0, ...extra });

test("a chat with neither request nor answer names no Task, and a stopped chat's Task is blocked", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-requestless-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new MeshStore(join(root, "mesh.json"), () => 10);
  const [empty, asked, stopped] = linkSessionsToProjects(store, [chat("empty-chat-01"),
    chat("asked-chat-01", { title: "Draw a harbour." }),
    chat("stopped-chat1", { title: "Draw a bridge.", summary: "Codex stopped: You’ve hit your usage limit.",
      stopped: { reason: "usage_limit", at: 2 } })], "mac", inspect, []);
  assert.equal(empty!.taskId, undefined);
  const askedTask = store.task(asked!.taskId!)!;
  assert.deepEqual([askedTask.title, askedTask.goal, askedTask.state], ["Draw a harbour.", "Draw a harbour.", "planned"]);
  assert.equal(store.task(stopped!.taskId!)!.state, "blocked");
});

test("a Task an earlier runtime made for a chat nobody asked anything is left out of snapshots", () => {
  const task = (taskId: string, title: string, goal: string) => ({ taskId, projectId: "p", title, goal, state: "planned" as const,
    createdAt: 1, updatedAt: 1 });
  assert.equal(requestlessTask({ title: "codex task", goal: "Continue this coding task" }), true);
  assert.equal(requestlessTask({ title: "codex task", goal: "Ship it" }), false);
  assert.equal(requestlessTask({ title: "Draw a harbour.", goal: "Continue this coding task" }), false);
  const { tasks, incomplete } = selectSnapshotTasks([task("junk", "codex task", "Continue this coding task"),
    task("real", "Draw a harbour.", "Draw a harbour.")]);
  assert.deepEqual(tasks.map((item) => item.taskId), ["real"]);
  assert.equal(incomplete, false);
});
