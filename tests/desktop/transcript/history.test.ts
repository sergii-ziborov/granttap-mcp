import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopTaskActivity } from "../../../apps/mcp/src/desktop/task-activity";
import { SessionActivity } from "../../../packages/protocol/schema";

test("desktop history keeps the exact Task scope, cursor and recorded changes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-desktop-history-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const storePath = join(directory, "mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "History", goal: "Test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "codex", computerId: "computer", workspace: directory, startedAt: 1 }],
  }));
  const activity = SessionActivity.parse({ type: "session.activity", sessionId: "s", agent: "codex", state: "working", generatedAt: 3,
    history: { cursor: "next", requestedCursor: "older", hasMore: true }, entries: [{ id: "final", kind: "final", text: "Done", createdAt: 2,
      callText: "Readable\ncall", resultText: "Saved", fileChangesComplete: true,
      fileChanges: [{ path: "/repo/a.ts", linesAdded: 1, linesRemoved: 1, diff: "-old\n+new", diffTruncated: false }] }] });
  let readCursor: string | undefined;
  const sources = { history: (_session: unknown, cursor?: string) => { readCursor = cursor; return activity; } };
  const result = desktopTaskActivity({ project_id: "p", task_id: "t", history_cursor: "older" }, storePath, sources);
  assert.equal(readCursor, "older");
  assert.equal(result?.entries[0]?.call_text, "Readable\ncall");
  assert.equal(result?.entries[0]?.file_changes_complete, true);
  assert.deepEqual(result?.entries[0]?.file_changes, activity.entries[0]?.fileChanges);
  assert.deepEqual(result?.history, activity.history);
  assert.equal(desktopTaskActivity({ project_id: "other", task_id: "t", history_cursor: "older" }, storePath, sources), undefined);
  assert.equal(desktopTaskActivity({ project_id: "p", task_id: "t", history_cursor: 4 }, storePath, sources), undefined);
});
