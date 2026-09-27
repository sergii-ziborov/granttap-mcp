import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopTaskSend } from "../../apps/mcp/src/desktop/delivery/task-send";

test("local Task send keeps the exact Mesh and native execution link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-task-send-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "mesh-a", name: "Mesh A", createdAt: 1 }],
    tasks: [{ taskId: "task-a", projectId: "mesh-a", title: "Test Task",
      goal: "test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "task-a", sessionId: "session-a", provider: "codex",
      computerId: "computer-a", workspace: directory, startedAt: 1, activeAt: 2 }],
  }));
  const calls: string[] = [];
  const deliver = async (session: { sessionId: string }, text: string) => {
    calls.push(`${session.sessionId}:${text}`);
    return { ok: true as const, text: "Done" };
  };
  const request = { project_id: "mesh-a", task_id: "task-a", session_id: "session-a",
    delivery_id: randomUUID(), text: "Continue" };
  assert.equal(await desktopTaskSend({ ...request, project_id: "other" }, storePath, deliver), undefined);
  assert.equal(await desktopTaskSend({ ...request, session_id: "other" }, storePath, deliver), undefined);
  assert.equal(await desktopTaskSend({ ...request, text: "" }, storePath, deliver), undefined);
  assert.deepEqual(await desktopTaskSend(request, storePath, deliver), {
    operation: "desktop.task_send", accepted: true, error: null,
  });
  await desktopTaskSend(request, storePath, deliver);
  assert.deepEqual(calls, ["session-a:Continue"]);
});
