import { join } from "node:path";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { readStoreState } from "../../../bridge/src/mesh/store/state";

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

/** Global Task index for the Mac's Now and Tasks views. */
export function desktopWorkspace(storePath = join(configDir(), "project-mesh.json")) {
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok" && loaded.status !== "missing") return undefined;
  const state = loaded.state;
  const projects = new Map(state.projects.map((project) => [project.projectId, project.name]));
  return {
    operation: "desktop.workspace" as const,
    project_count: state.projects.length,
    task_count: state.tasks.length,
    tasks: [...state.tasks].sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 256).map((task) => ({
        project_id: task.projectId, project_name: projects.get(task.projectId) ?? "Project",
        task_id: task.taskId, title: task.title, state: task.state,
        updated_at: task.updatedAt,
        ...executionFacts(state.executions, task.taskId),
      })),
  };
}
