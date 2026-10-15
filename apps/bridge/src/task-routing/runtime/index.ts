import type { PeerConfig, RelayClient } from '../../../../../packages/core/relay-client';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
import { loadRuntimeConfig } from '../../config';
import { localMeshStore } from '../../mesh/local-remote/local';
import { workingTreeState } from '../../mesh/catalog';
import { createLocalMeshRuntime, meshCatalog } from '../../mesh/runtime';
import { scanSessions } from '../../sessions';
import { controllerPeerGate } from '../../pairing/controllers';
import { localTaskNetwork } from '../../task-network/runtime/configuration';
import { localProjectConfigurationSync } from '../../task-network/configuration/runtime';
import { localPeerTransferSender, submitNetworkTransfer } from '../../task-network/source/runtime';
import { localRoutingRequests, type RoutingRequest } from '../requests';
import { RoutingRequestProcessor } from '../requests/processor';
import { TaskResourceRouter } from './router';
import { observeRoutingComputer } from './observation';
import { observedRoutingSession } from '../observed-turn';

/** The monitor owns deferred admission after the originating tool process or phone exits. */
export function startAutomaticTaskRouting(input: { config: PeerConfig; client: RelayClient; online: () => boolean;
  publish: () => Promise<void> }): () => void {
  const { config } = input, store = localMeshStore(), requests = localRoutingRequests();
  let stopped = false;
  const router = new TaskResourceRouter({ config, network: localTaskNetwork(config), store,
    enabled: () => !stopped && input.online() && loadRuntimeConfig().meshEnabled,
    controllerAllowed: controllerPeerGate(config), refresh: id => localProjectConfigurationSync(config).refresh(id),
    clean: path => workingTreeState(path) === 'clean',
    observe: (project, workspace) => observeRoutingComputer(config, project, workspace),
    currentSession: id => session(id),
    requestCurrent: row => requests.get(row.id)?.phase === 'preparing' && row.expiresAt > Date.now(),
    prepare: (request, preparation) => createLocalMeshRuntime({ eventId: () => preparation.eventId,
      dispatchPreparedTransfer: (event, session, confirm) => submitNetworkTransfer(event, session,
        async () => await confirm() && await preparation.confirmPolicy(),
        { automatic: true, routing: preparation.routing, forward: preparation.forward }) }).prepare(input.client, request) });
  const session = async (id: string) => {
    const current = meshCatalog(scanSessions().sessions).find(row => row.sessionId === id);
    return current?.state === 'idle' ? observedRoutingSession(current) : current;
  };
  const changed = (row: RoutingRequest) => {
    if (row.phase === 'failed') publishRoutingFailure(row);
    void input.publish().catch(() => {});
  };
  const processor = new RoutingRequestProcessor({ store: requests, session,
    route: (row, current) => router.route(row, current as SessionInfo),
    recover: async row => localPeerTransferSender(config).hasDurableRequest(row.source.projectId, `automatic-${row.id}`)
      ? 'submitted' : 'failed', onChange: changed });
  const tick = () => { if (!stopped && input.online()) void processor.tick().catch(() => {}); };
  const timer = setInterval(tick, 2_000); timer.unref(); tick();
  return () => { stopped = true; clearInterval(timer); };
}

function publishRoutingFailure(row: RoutingRequest): void {
  const reason = row.code === 'source_changed'
    ? 'The source execution changed. Request a new computer transfer from the current chat.'
    : row.code === 'expired'
      ? 'The computer transfer was not confirmed before it expired. The source chat can continue.'
      : 'The computer transfer was not prepared. Check the committed source checkout, compatible computers and Project permission.';
  const now = Date.now();
  localMeshStore().acceptEvent({ type: 'mesh.event', sessionId: row.source.taskId, eventId: `automatic-result-${row.id}`,
    projectId: row.source.projectId, taskId: row.source.taskId, sourceSessionId: row.source.sessionId,
    eventType: 'TASK_BLOCKED', createdAt: now, expiresAt: now + 86_400_000, payload: { reason, needsUser: true, failed: true } });
}
