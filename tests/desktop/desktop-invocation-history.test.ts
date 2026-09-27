import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopInvocationHistory } from "../../apps/mcp/src/desktop/invocation";

test("local invocation history stays within the requested Mesh Task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-invocation-"));
  const storePath = join(directory, "mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "mesh-a", name: "Mesh A", createdAt: 1 }],
    tasks: [{ taskId: "task-a", projectId: "mesh-a", title: "Test",
      goal: "test", state: "working", createdAt: 1, updatedAt: 2 }],
  }));
  const calls: string[] = [];
  const engine = { request: async (query: { input: { task_id: string } }) => {
    calls.push(query.input.task_id);
    return { operation: "invocation.history", page: { events: [], next_sequence: 0,
      previous_sequence: 0, has_more: false, has_older: false } };
  } };
  assert.equal(await desktopInvocationHistory({ project_id: "other", task_id: "task-a" },
    engine as never, storePath), undefined);
  assert.equal(await desktopInvocationHistory({ project_id: "mesh-a", task_id: "other" },
    engine as never, storePath), undefined);
  assert.deepEqual(await desktopInvocationHistory({ project_id: "mesh-a", task_id: "task-a" },
    engine as never, storePath), { operation: "desktop.invocation_history",
      project_id: "mesh-a", task_id: "task-a", events: [], has_older: false });
  assert.deepEqual(calls, ["task-a"]);
});
