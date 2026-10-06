import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopTaskHandoff } from "../../../apps/mcp/src/desktop/delivery/task-handoff";

test("desktop handoff uses only the owning local execution and forwards model and comment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-handoff-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "project", name: "Project", createdAt: 1 }],
    tasks: [{ taskId: "task", projectId: "project", title: "Task", goal: "Goal",
      state: "working", ownerSessionId: "source", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "task", sessionId: "source", provider: "codex",
      computerId: "this-mac", workspace: directory, startedAt: 1 }],
  }));
  const sent: unknown[] = [];
  const prepare = async (request: unknown) => { sent.push(request); return true; };
  const request = { project_id: "project", task_id: "task", session_id: "source",
    target_provider: "claude", target_computer: "other-mac", target_model: "opus",
    user_comment: "Inspect the tests first.", checkpoint: true, push: true };
  assert.equal((await desktopTaskHandoff({ ...request, session_id: "other" }, storePath,
    prepare, "this-mac") as { accepted?: boolean })?.accepted, undefined);
  assert.equal((await desktopTaskHandoff({ ...request, target_model: "--bad" }, storePath,
    prepare, "this-mac") as { accepted?: boolean })?.accepted, undefined);
  assert.deepEqual(await desktopTaskHandoff(request, storePath, prepare, "this-mac"), {
    operation: "desktop.task_handoff", accepted: true, error: null,
  });
  assert.deepEqual(sent, [{
    type: "mesh.handoff.prepare", sessionId: "source", projectId: "project", taskId: "task",
    targetProvider: "claude", targetComputer: "other-mac", targetModel: "opus",
    userComment: "Inspect the tests first.", checkpoint: true, push: true,
    createdAt: (sent[0] as { createdAt: number }).createdAt,
  }]);
});
