import { join } from "node:path";
import { RelayClient } from "../../../../../packages/core/relay-client";
import { MeshHandoffPrepare, type MeshHandoffPrepare as HandoffRequest } from "../../../../../packages/protocol/schema";
import { configDir, loadConfig, machineConfigPath } from "../../../../bridge/src/config";
import { applyNetworkRoute } from "../../../../bridge/src/device-network/settings";
import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { prepareMeshHandoff } from "../../../../bridge/src/mesh/runtime";
import { readStoreState } from "../../../../bridge/src/mesh/store/state";
import { controllerPeerGate } from "../../../../bridge/src/pairing/controllers";

type Prepare = (request: HandoffRequest) => Promise<boolean>;

async function prepareThroughRelay(request: HandoffRequest): Promise<boolean> {
  const config = applyNetworkRoute(loadConfig(machineConfigPath()));
  const client = new RelayClient(config, { peerAllowed: controllerPeerGate(config) });
  try {
    await client.connect();
    return await prepareMeshHandoff(client, request);
  } finally {
    client.close();
  }
}

/** Same-user Mac request, limited to the exact Task owner on this computer. */
export async function desktopTaskHandoff(
  input: unknown,
  storePath = join(configDir(), "project-mesh.json"),
  prepare: Prepare = prepareThroughRelay,
  localComputer = observedComputerId(),
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  const request = MeshHandoffPrepare.safeParse({
    type: "mesh.handoff.prepare",
    sessionId: row.session_id, projectId: row.project_id, taskId: row.task_id,
    targetProvider: row.target_provider, targetComputer: row.target_computer,
    targetModel: row.target_model, userComment: row.user_comment,
    checkpoint: row.checkpoint, push: row.push, createdAt: Date.now(),
  });
  if (!request.success) return undefined;
  const loaded = readStoreState(storePath);
  if (loaded.status !== "ok") return undefined;
  const task = loaded.state.tasks.find((item) => item.taskId === request.data.taskId);
  const execution = loaded.state.executions.find((item) =>
    item.taskId === request.data.taskId && item.sessionId === request.data.sessionId
      && item.endedAt == null && item.computerId === localComputer);
  if (task?.projectId !== request.data.projectId || task.ownerSessionId !== request.data.sessionId
    || !execution?.workspace) return undefined;
  try {
    const accepted = await prepare(request.data);
    return { operation: "desktop.task_handoff", accepted,
      error: accepted ? null : "The handoff was not ready. Check the Task and its repository." };
  } catch {
    return { operation: "desktop.task_handoff", accepted: false,
      error: "The local relay or handoff service is unavailable." };
  }
}
