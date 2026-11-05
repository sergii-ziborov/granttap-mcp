import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeEngineFrame } from "../../../../bridge/src/engine/protocol/engine-protocol";
import { desktopMeshSnapshots } from "../mesh-project";

test("Mac Mesh catalog pages stay below the desktop frame limit without losing projects", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-mesh-pages-"));
  const storePath = join(directory, "project-mesh.json");
  const projects = Array.from({ length: 256 }, (_, index) => ({
    projectId: `mesh-${String(index).padStart(3, "0")}`,
    name: `Mesh ${index}`,
    canonicalRepositoryId: `local:mesh-${index}`,
    createdAt: 1,
  }));
  const tasks = projects.map((project, index) => ({
    taskId: `task-${index}`, projectId: project.projectId,
    title: `Task ${index}`, goal: "g".repeat(1_000), state: "planned",
    createdAt: 1, updatedAt: 1,
  }));
  writeFileSync(storePath, JSON.stringify({ version: 1, projects, tasks, executions: [] }));
  try {
    let after: string | undefined;
    const received: string[] = [];
    for (let page = 0; page < 256; page += 1) {
      const result = desktopMeshSnapshots({ limit: "16", after_project_id: after }, storePath);
      assert.ok(result);
      const frame = encodeEngineFrame({ protocol_version: 1, request_id: "test", status: "ok", result });
      assert.ok(frame.length <= 512 * 1_024 + 4);
      received.push(...result.snapshots.map((snapshot) => snapshot.projectId));
      if (!result.next_after_project_id) break;
      assert.notEqual(result.next_after_project_id, after);
      after = result.next_after_project_id;
    }
    assert.deepEqual(received, projects.map((project) => project.projectId));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
