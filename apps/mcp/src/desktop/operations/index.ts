import { desktopHookTrust } from "../provider-hooks";
import { desktopProjectAutoAccept } from "../policy/auto-accept";
import { desktopProjectPolicy } from "../policy";
import { desktopProjectCatalog } from "../project-catalog";
import { desktopFixtureSnapshot, desktopMeshProject, desktopMeshSnapshots, desktopWorkspace } from "../mesh-project";
import { localMeshStore } from "../../../../bridge/src/mesh/local-remote/local";
import { desktopMachineLoad } from "../load";
import type { DesktopTaskActivityRunner } from "../task-activity-runner";
import type { EngineClient } from "../../../../bridge/src/engine/runtime/engine-client";
import type { EngineOperation } from "../../../../bridge/src/engine/protocol/engine-protocol";
import { desktopTaskSend } from "../delivery/task-send";
import { desktopTaskCreate } from "../delivery/task-create";
import { desktopMeshCreate } from "../delivery/mesh-create";
import { desktopInvocationHistory } from "../invocation";
import { desktopUsage } from "../projection/usage";
import { desktopInstalledSkills } from "../projection/installed-skills";
import type { DesktopControllerEnrollment } from "../pairing";

export function desktopReadOperation(input: {
  operation: string; queryInput: unknown; storePath?: string;
  engine: Pick<EngineClient, "request">; activity: DesktopTaskActivityRunner;
  enrichment: DesktopTaskActivityRunner;
  controllerEnrollment?: DesktopControllerEnrollment;
}): Promise<unknown> {
  const { operation, queryInput, storePath, engine, activity, enrichment } = input;
  if (operation === "desktop.controller_enrollment") {
    return input.controllerEnrollment?.read(queryInput) ?? Promise.resolve(undefined);
  }
  if (operation === "desktop.project_auto_accept") {
    return Promise.resolve(desktopProjectAutoAccept(queryInput, { storePath }));
  }
  if (operation === "desktop.policy_status" || operation === "desktop.policy_set") {
    return desktopProjectPolicy(operation, queryInput, { storePath, engine });
  }
  if (operation === "desktop.codex_hook_trust") return desktopHookTrust(queryInput);
  if (operation === "desktop.capability_usage") return desktopUsage();
  if (operation === "desktop.installed_skills") {
    return Promise.resolve(desktopInstalledSkills(queryInput, storePath));
  }
  if (operation === "desktop.mesh_snapshots") {
    return Promise.resolve(desktopMeshSnapshots(storePath));
  }
  if (operation === "desktop.live_catalog") return activity.liveCatalog(storePath);
  if (operation === "desktop.machine_load") return desktopMachineLoad();
  if (operation === "desktop.task_activity") return activity.read(queryInput, storePath);
  if (operation === "desktop.task_image") return activity.image(queryInput, storePath);
  if (operation === "desktop.task_send") return desktopTaskSend(queryInput, storePath);
  if (operation === "desktop.task_create") return desktopTaskCreate(queryInput, storePath);
  if (operation === "desktop.mesh_create") return Promise.resolve(desktopMeshCreate(queryInput, storePath));
  if (operation === "desktop.invocation_history") {
    return desktopInvocationHistory(queryInput, engine, storePath);
  }
  if (operation === "desktop.project") {
    return Promise.resolve(desktopMeshProject(queryInput, storePath));
  }
  if (operation === "desktop.workspace") {
    return Promise.resolve(desktopWorkspace(storePath));
  }
  if (operation === "desktop.mesh_snapshot") {
    const projectId = (queryInput as { project_id?: unknown } | undefined)?.project_id;
    if (typeof projectId !== "string" || !projectId || projectId.length > 128) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(storePath
      ? desktopFixtureSnapshot(queryInput, storePath)
      : (queryInput as { enrich?: unknown }).enrich === "true"
        ? enrichment.enrichedSnapshot(projectId) : localMeshStore().snapshot(projectId));
  }
  if (operation === "project.list") {
    const catalog = desktopProjectCatalog(queryInput, storePath);
    if (catalog) return Promise.resolve(catalog);
  }
  const query = queryInput === undefined ? { operation } : { operation, input: queryInput };
  return engine.request(query as EngineOperation, { timeoutMs: 5_000 });
}
