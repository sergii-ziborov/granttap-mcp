import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readStoreState } from "../../../apps/bridge/src/mesh/store/state";

const project = (id: string) => ({
  projectId: id, name: id, canonicalRepositoryId: `github.com/example/${id}`, createdAt: 1,
});
const task = (id: string, projectId: string) => ({
  taskId: id, projectId, title: id, goal: id, state: "working", createdAt: 1, updatedAt: 1,
});

for (const scenario of [
  { name: "different Projects", projectIds: ["one", "two"],
    providers: ["claude", "claude"], endpoints: ["mac", "mac"] },
  { name: "different providers", projectIds: ["one", "one"],
    providers: ["claude", "codex"], endpoints: ["mac", "mac"] },
  { name: "different endpoints without proven alias", projectIds: ["one", "one"],
    providers: ["claude", "claude"], endpoints: ["mac-1", "mac-2"] },
  { name: "different workspaces", projectIds: ["one", "one"],
    providers: ["claude", "claude"], endpoints: ["mac", "mac"], workspaces: ["/one", "/two"] },
]) {
  test(`same native session ID keeps separate Tasks on ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "granttap-rejoin-scope-"));
    const path = join(root, "mesh.json");
    try {
      writeFileSync(path, JSON.stringify({
        version: 1, projects: [...new Set(scenario.projectIds)].map(project),
        tasks: scenario.projectIds.map((id, index) => task(`task-${index}`, id)),
        executions: scenario.projectIds.map((_, index) => ({
          taskId: `task-${index}`, sessionId: "same-native-id",
          provider: scenario.providers[index], computerId: scenario.endpoints[index],
          workspace: scenario.workspaces?.[index] ?? "/repo", startedAt: index + 1,
        })),
      }));
      const loaded = readStoreState(path);
      assert.equal(loaded.status, "ok");
      assert.deepEqual(loaded.state.tasks.map((item) => item.taskId), ["task-0", "task-1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("colliding Task IDs across Projects do not authorize a rejoin", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-rejoin-collision-"));
  const path = join(root, "mesh.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 1, projects: [project("one"), project("two")],
      tasks: [task("same-task-id", "one"), task("same-task-id", "two"), task("other-task", "one")],
      executions: ["same-task-id", "other-task"].map((taskId, index) => ({
        taskId, sessionId: "native-id", provider: "claude", computerId: "mac",
        workspace: "/repo", startedAt: index + 1,
      })),
    }));
    const loaded = readStoreState(path);
    assert.equal(loaded.status, "ok");
    assert.equal(loaded.state.tasks.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
