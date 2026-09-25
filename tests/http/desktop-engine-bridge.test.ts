import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDesktopEngineBridge } from "../../apps/mcp/src/desktop/engine-bridge";
import { desktopWorkspace } from "../../apps/mcp/src/desktop/mesh-project";
import { desktopTaskActivity } from "../../apps/mcp/src/desktop/task-activity";
import { encodeEngineFrame } from "../../apps/bridge/src/engine/protocol/engine-protocol";

function exchange(path: string, request: object): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(encodeEngineFrame(request)));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
}

test("desktop Engine bridge forwards reads and blocks writes", async (t) => {
  const calls: string[] = [];
  const bridge = await startDesktopEngineBridge({
    client: {
      async request(query) {
        calls.push(query.operation);
        return {
          operation: "engine.version" as const, protocol_version: 1 as const,
          engine_version: "test", cortex_version: "test", cortex_revision: "test",
          weavatrix_version: "test",
        };
      },
      close() {},
    },
  });
  t.after(() => bridge.close());
  const read = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "read", operation: "engine.version",
  });
  const readBody = JSON.parse(read.subarray(4).toString("utf8")) as {
    status: string; result: { engine_version: string };
  };
  assert.equal(read.readUInt32BE(0), read.length - 4);
  assert.equal(readBody.status, "ok");
  assert.equal(readBody.result.engine_version, "test");

  const write = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "write", operation: "policy.apply", input: {},
  });
  assert.equal(write.length, 0);
  assert.deepEqual(calls, ["engine.version"]);
});

test("desktop bridge finds Mesh Projects when an installed Engine lacks catalog reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-catalog-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1, projects: [
    { projectId: "a", name: "Lowercase", canonicalRepositoryId: "repo-a", createdAt: 2 },
    { projectId: "A", name: "Uppercase", canonicalRepositoryId: "repo-A", createdAt: 1 },
  ], tasks: [{ taskId: "task-one", projectId: "A", title: "Fix Mac",
    goal: "Private task prompt", state: "working", createdAt: 1, updatedAt: 2 }],
  executions: [{ taskId: "task-one", sessionId: "session-one", provider: "codex",
    computerId: "computer-one", workspace: "/tmp/project", startedAt: 1,
    activeAt: 2 }] }));
  const bridge = await startDesktopEngineBridge({
    storePath,
    client: {
      async request() { throw new Error("unsupported operation"); },
      close() {},
    },
  });
  t.after(() => bridge.close());
  const response = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "catalog", operation: "project.list",
    input: { limit: 50 },
  });
  const body = JSON.parse(response.subarray(4).toString("utf8")) as {
    status: string; result: { page: { projects: Array<{ name: string }> } };
  };
  assert.equal(body.status, "ok");
  assert.deepEqual(body.result.page.projects.map((item) => item.name), ["Uppercase", "Lowercase"]);

  const meshResponse = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "mesh", operation: "desktop.project",
    input: { project_id: "A" },
  });
  const meshBody = JSON.parse(meshResponse.subarray(4).toString("utf8")) as {
    status: string; result: { project_id: string;
      tasks: Array<{ title: string; has_open_execution: boolean;
        last_execution_active_at: number | null }> };
  };
  assert.equal(meshBody.status, "ok");
  assert.equal(meshBody.result.project_id, "A");
  assert.deepEqual(meshBody.result.tasks.map((item) => item.title), ["Fix Mac"]);
  assert.equal(meshBody.result.tasks[0]?.has_open_execution, true);
  assert.equal(meshBody.result.tasks[0]?.last_execution_active_at, 2);
  assert.doesNotMatch(JSON.stringify(meshBody), /Private task prompt/);

  const workspaceResponse = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "workspace", operation: "desktop.workspace",
  });
  const workspaceBody = JSON.parse(workspaceResponse.subarray(4).toString("utf8")) as {
    status: string; result: { project_count: number; task_count: number;
      tasks: Array<{ title: string; project_name: string; has_open_execution: boolean;
        last_execution_active_at: number | null }> };
  };
  assert.equal(workspaceBody.status, "ok");
  assert.equal(workspaceBody.result.project_count, 2);
  assert.equal(workspaceBody.result.task_count, 1);
  assert.deepEqual(workspaceBody.result.tasks.map((item) => item.title), ["Fix Mac"]);
  assert.equal(workspaceBody.result.tasks[0]?.has_open_execution, true);
  assert.equal(workspaceBody.result.tasks[0]?.last_execution_active_at, 2);
  assert.doesNotMatch(JSON.stringify(workspaceBody), /Private task prompt/);

  const activityResponse = await exchange(bridge.socketPath, {
    protocol_version: 1, request_id: "activity", operation: "desktop.task_activity",
    input: { project_id: "A", task_id: "task-one" },
  });
  const activityBody = JSON.parse(activityResponse.subarray(4).toString("utf8")) as {
    status: string; result: { project_id: string; task_id: string; entries: unknown[] };
  };
  assert.equal(activityBody.status, "ok");
  assert.equal(activityBody.result.project_id, "A");
  assert.equal(activityBody.result.task_id, "task-one");
  assert.doesNotMatch(JSON.stringify(activityBody), /Private task prompt/);
});

test("desktop workspace includes every Task in a 134-Task local Mesh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-workspace-"));
  const storePath = join(directory, "project-mesh.json");
  const tasks = Array.from({ length: 134 }, (_, index) => ({
    taskId: `task-${index}`, projectId: "project", title: `Task ${index}`,
    goal: "Test goal", state: "planned", createdAt: index, updatedAt: index,
  }));
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "project", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks,
  }));
  const workspace = desktopWorkspace(storePath);
  assert.equal(workspace?.task_count, 134);
  assert.equal(workspace?.tasks.length, 134);
  assert.equal(workspace?.tasks.at(-1)?.task_id, "task-0");
});

test("desktop workspace does not call an ended execution live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-ended-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "project", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "task", projectId: "project", title: "Old work",
      goal: "Test goal", state: "working", createdAt: 1, updatedAt: 3 }],
    executions: [{ taskId: "task", sessionId: "session", provider: "codex",
      computerId: "computer", workspace: "/tmp/project", startedAt: 1, activeAt: 2, endedAt: 3 }],
  }));
  const task = desktopWorkspace(storePath)?.tasks[0];
  assert.equal(task?.has_open_execution, false);
  assert.equal(task?.last_execution_active_at, null);
});

test("desktop conversation follows the exact Project Task execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-chat-"));
  const storePath = join(directory, "project-mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "project", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "task", projectId: "project", title: "Fix Mac",
      goal: "Test goal", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "task", sessionId: "session", provider: "codex",
      computerId: "computer", workspace: "/tmp/project", startedAt: 1, activeAt: 2 }],
  }));
  const sources = {
    sessions: () => [{ sessionId: "session", agent: "codex" as const, state: "working" as const,
      startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }],
    activity: () => ({ type: "session.activity" as const, sessionId: "session",
      agent: "codex" as const, state: "working" as const, generatedAt: 3,
      entries: [{ id: "entry", kind: "message" as const, text: "Synthetic reply",
        createdAt: 2 }] }),
  };
  const result = desktopTaskActivity({ project_id: "project", task_id: "task" }, storePath, sources);
  assert.equal(result?.session_id, "session");
  assert.equal(result?.entries[0]?.text, "Synthetic reply");
  assert.equal(desktopTaskActivity({ project_id: "other", task_id: "task" }, storePath, sources),
    undefined);
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [
      { projectId: "project", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 },
      { projectId: "other", name: "Other", canonicalRepositoryId: "other", createdAt: 1 },
    ],
    tasks: [
      { taskId: "task", projectId: "project", title: "Fix Mac",
        goal: "Test goal", state: "working", createdAt: 1, updatedAt: 2 },
      { taskId: "task", projectId: "other", title: "Other work",
        goal: "Other goal", state: "working", createdAt: 1, updatedAt: 2 },
    ],
    executions: [{ taskId: "task", sessionId: "session", provider: "codex",
      computerId: "computer", workspace: "/tmp/project", startedAt: 1 }],
  }));
  assert.equal(desktopTaskActivity({ project_id: "project", task_id: "task" }, storePath, sources),
    undefined);
});
