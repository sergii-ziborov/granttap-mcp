import { join } from "node:path";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../bridge/src/mesh/store/state";
import { selectSnapshotTasks } from "../../../bridge/src/mesh/snapshot/window";
import { MeshSnapshot } from "../../../../packages/protocol/schema";

type DesktopExecution = {
  taskId: string; provider: string; startedAt: number;
  endedAt?: number; activeAt?: number;
};

function executionFacts(executions: DesktopExecution[], taskId: string) {
  const matching = executions.filter((item) => item.taskId === taskId)
    .sort((left, right) => right.startedAt - left.startedAt);
  const open = matching.find((item) => item.endedAt === undefined);
  return {
    provider: (open ?? matching[0])?.provider ?? null,
    has_open_execution: open !== undefined,
    last_execution_active_at: open?.activeAt ?? null,
  };
}

/** Bounded, read-only Task state from the same local Project Mesh as the phone. */
export function desktopMeshProject(input: unknown, storePath = join(configDir(), "project-mesh.json")) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const projectId = (input as Record<string, unknown>).project_id;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return undefined;
  const project = loaded.state.projects.find((item) => item.projectId === projectId);
  if (!project) return undefined;
  const executions = loaded.state.executions;
  return {
    operation: "desktop.project" as const,
    project_id: projectId,
    tasks: loaded.state.tasks.filter((item) => item.projectId === projectId).slice(0, 64)
      .map((item) => ({
        task_id: item.taskId, title: item.title, state: item.state,
        updated_at: item.updatedAt,
        ...executionFacts(executions, item.taskId),
      })),
  };
}

/** Fixture-store projection for isolated bridge tests; production uses the canonical runtime. */
export function desktopFixtureSnapshot(
  input: unknown, storePath = join(configDir(), "project-mesh.json")
) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const projectId = (input as Record<string, unknown>).project_id;
  if (typeof projectId !== "string" || !projectId || projectId.length > 128) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return undefined;
  const state = loaded.state;
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project) return undefined;
  const selected = selectSnapshotTasks(state.tasks.filter((item) => item.projectId === projectId));
  const taskIds = new Set(selected.tasks.map((item) => item.taskId));
  const bindings = state.bindings.filter((item) => item.projectId === projectId);
  const peers = state.peers.filter((item) => item.projectId === projectId);
  const executions = state.executions.filter((item) => taskIds.has(item.taskId));
  const claims = state.claims.filter((item) => item.projectId === projectId
    && taskIds.has(item.taskId) && item.expiresAt > Date.now());
  const dependencies = state.dependencies.filter((item) => taskIds.has(item.taskId));
  const events = state.events.filter((item) => item.projectId === projectId && taskIds.has(item.taskId));
  const incomplete = selected.incomplete || bindings.length > 64 || peers.length > 64
    || executions.length > 128 || claims.length > 128 || dependencies.length > 128
    || events.length > 128;
  return MeshSnapshot.parse({
    type: "mesh.snapshot", sessionId: projectId, projectId, project,
    bindings: bindings.slice(0, 64), peers: peers.slice(-64),
    tasks: selected.tasks, executions: executions.slice(-128),
    claims: claims.slice(-128), dependencies: dependencies.slice(-128),
    events: events.slice(-128), incomplete: incomplete || undefined,
    generatedAt: Date.now(),
  });
}

/** Durable Mesh list; live Engine enrichment is requested for the selected Mesh only. */
export function desktopMeshSnapshots(storePath = join(configDir(), "project-mesh.json")) {
  return {
    operation: "desktop.mesh_snapshots" as const,
    snapshots: (desktopWorkspace(storePath)?.projects ?? []).flatMap((project) =>
      desktopFixtureSnapshot({ project_id: project.project_id }, storePath) ?? []),
  };
}

/** Global Task index for the Mac's Now and Tasks views. */
export function desktopWorkspace(storePath = join(configDir(), "project-mesh.json")) {
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok" && loaded.status !== "missing") return undefined;
  const state = loaded.state;
  const projects = new Map(state.projects.map((project) => [project.projectId, project.name]));
  const taskCounts = new Map<string, number>();
  for (const task of state.tasks) {
    taskCounts.set(task.projectId, (taskCounts.get(task.projectId) ?? 0) + 1);
  }
  return {
    operation: "desktop.workspace" as const,
    project_count: state.projects.length,
    task_count: state.tasks.length,
    projects: state.projects.slice(0, 256).map((project) => ({
      project_id: project.projectId,
      name: project.name,
      task_count: taskCounts.get(project.projectId) ?? 0,
      repository_count: new Set([
        project.canonicalRepositoryId,
        ...state.bindings.filter((binding) => binding.projectId === project.projectId)
          .map((binding) => binding.repositoryId),
      ]).size,
    })),
    tasks: [...state.tasks].sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 256).map((task) => ({
        project_id: task.projectId, project_name: projects.get(task.projectId) ?? "Project",
        task_id: task.taskId, title: task.title, state: task.state,
        updated_at: task.updatedAt,
        ...executionFacts(state.executions, task.taskId),
      })),
  };
}
