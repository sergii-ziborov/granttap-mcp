import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const options: unknown[] = [];
  const deliver = async (session: { sessionId: string }, text: string, _time?: number,
    _attachments?: unknown[], turn?: unknown) => {
    calls.push(`${session.sessionId}:${text}`);
    options.push(turn);
    return { ok: true as const, text: "Done" };
  };
  const request = { project_id: "mesh-a", task_id: "task-a", session_id: "session-a",
    delivery_id: randomUUID(), text: "Continue", model: "gpt-6-astra" };
  assert.equal(await desktopTaskSend({ ...request, project_id: "other" }, storePath, deliver), undefined);
  assert.equal(await desktopTaskSend({ ...request, session_id: "other" }, storePath, deliver), undefined);
  assert.equal(await desktopTaskSend({ ...request, text: "" }, storePath, deliver), undefined);
  assert.deepEqual(await desktopTaskSend(request, storePath, deliver), {
    operation: "desktop.task_send", accepted: true, error: null,
  });
  await desktopTaskSend(request, storePath, deliver);
  assert.deepEqual(calls, ["session-a:Continue"]);
  assert.deepEqual(options, [{ model: "gpt-6-astra" }], "confirmed model must reach the exact resumed execution");
  assert.equal(await desktopTaskSend({ ...request, delivery_id: randomUUID(), model: "--invalid" }, storePath, deliver), undefined);
});

test("local Task accepts a source file without a caption and rejects untrusted attachment paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-message-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "files", name: "Files", createdAt: 1 }],
    tasks: [{ taskId: "task", projectId: "files", title: "Test", goal: "test",
      state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "task", sessionId: "session", provider: "codex",
      computerId: "computer", workspace: directory, startedAt: 1, activeAt: 2 }],
  }));
  const path = join(directory, "0");
  await writeFile(path, "let answer = 42\n", { mode: 0o600 });
  await chmod(directory, 0o700);
  const files = [{ name: "Answer.swift", mimeType: "text/plain", path }];
  const request = { project_id: "files", task_id: "task", session_id: "session",
    delivery_id: randomUUID(), text: "", attachments_json: JSON.stringify(files) };
  const delivered: unknown[] = [];
  const deliver = async (_session: unknown, _text: string, _timeout?: number, attachments?: unknown[]) => {
    delivered.push(attachments);
    return { ok: true as const, text: "Done" };
  };
  try {
    const result = await desktopTaskSend(request, storePath, deliver);
    assert.equal((result as { accepted?: boolean })?.accepted, true);
    assert.deepEqual(delivered, [[{ name: "Answer.swift", mimeType: "text/plain",
      data: Buffer.from("let answer = 42\n").toString("base64") }]]);
    assert.equal(await desktopTaskSend({ ...request, delivery_id: randomUUID(), text: "Inspect",
      attachments_json: JSON.stringify([{ ...files[0], path: storePath }]) }, storePath, deliver), undefined);
    assert.equal(await desktopTaskSend({ ...request, delivery_id: randomUUID(), text: "Inspect",
      attachments_json: "bad JSON" }, storePath, deliver), undefined);
    assert.equal(delivered.length, 1, "invalid attachments must not be silently dropped");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
