import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { MeshEvent, MeshHandoffPrepare, SessionInfo } from "../../../../../../packages/protocol/schema";
import type { MeshRuntimeDependencies } from "../dependencies";
import { createHandoffFlow } from "../handoff";
import { prepareCloudHandoff } from "../cloud-handoff";
import { capturePreparedHandoff, preparedHandoffMetadata } from ".";
import { prepareSourceCapsule } from "./source";
import { resolveHandoffSource } from "./source-binding";

export async function prepareHandoff(
  deps: MeshRuntimeDependencies,
  flow: ReturnType<typeof createHandoffFlow>,
  client: RelayClient,
  request: MeshHandoffPrepare,
  catalog: (sessions: SessionInfo[]) => SessionInfo[],
): Promise<boolean> {
  const { blockHandoff, acceptHandoff } = flow;
  const sessions = catalog(deps.sessions());
  const native = sessions.find((item) => item.sessionId === request.sessionId);
  let session = native;
  if (!session) {
    const task = deps.store().task(request.taskId);
    if (task?.projectId === request.projectId && task.ownerSessionId === request.sessionId) {
      await blockHandoff(client, request, "The source chat is no longer available. Refresh this Task on its computer and retry.");
    }
    return false;
  }
  if (session.projectId !== request.projectId || session.taskId !== request.taskId) return false;
  try { session = resolveHandoffSource(deps.store(), session, request, deps.computer()); }
  catch (error) {
    await blockHandoff(client, request, (error as Error).message);
    return false;
  }
  if (request.prepareOnly && session.state === "working") {
    await blockHandoff(client, request, "Pause or finish the current turn before transferring this Task.");
    return false;
  }
  const cwd = session.worktree ?? session.cwd;
  let capsule = await prepareSourceCapsule({ deps, blockHandoff, client, request, session, sessions });
  if (!capsule) return false;
  if (request.cloud) return prepareCloudHandoff({ deps, block: blockHandoff, client, request, session, capsule });
  let transferContext: string | undefined;
  let confirmContext: (() => Promise<boolean>) | undefined;
  if (request.prepareOnly) {
    try {
      const captured = await capturePreparedHandoff(deps, session, capsule, native);
      transferContext = captured.transferContext;
      capsule = captured.capsule;
      confirmContext = captured.confirm;
    } catch (error) {
      await blockHandoff(client, request, error instanceof Error ? error.message : "The complete transfer context is unavailable.");
      return false;
    }
  }
  const local = request.targetComputer === deps.computer();
  if (request.push && !local && cwd) {
    const pushed = deps.push(cwd, capsule.branch);
    if (!pushed.ok) {
      await blockHandoff(client, request, pushed.error);
      return false;
    }
  }
  const createdAt = deps.now();
  const event: MeshEvent = {
    type: "mesh.event",
    sessionId: request.taskId,
    eventId: deps.eventId(),
    projectId: request.projectId,
    taskId: request.taskId,
    sourceSessionId: request.sessionId,
    eventType: "HANDOFF_REQUEST",
    createdAt,
    expiresAt: createdAt + 60 * 60_000,
    payload: { capsule, transferContext },
  };
  if (request.prepareOnly && !local && deps.dispatchPreparedTransfer) {
    try {
      if (await deps.dispatchPreparedTransfer(event, session, confirmContext!)) {
        await deps.send(client, preparedHandoffMetadata(event), { ttlMs: 60 * 60_000, wake: true }).catch(() => {});
        return true;
      }
      await blockHandoff(client, request, 'Project computer transfer is not configured for this destination. Connect its Project in GrantTap.');
    } catch (error) {
      await blockHandoff(client, request, error instanceof Error ? error.message : 'The transfer could not be saved.');
    }
    return false;
  }
  deps.store().acceptEvent(event);
  await deps.send(client, request.prepareOnly ? preparedHandoffMetadata(event) : event, { ttlMs: 60 * 60_000, wake: true });
  if (local) await acceptHandoff(client, event);
  return true;
}

