import { join } from 'node:path';
import type { MeshEvent, SessionInfo } from '../../../../../packages/protocol/schema';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { PeerTaskTransfer } from '../../../../../packages/protocol/task-network';
import { configDir, loadConfig, machineConfigPath, loadRuntimeConfig } from '../../config';
import { applyNetworkRoute } from '../../device-network/settings';
import { controllerPeerGate } from '../../pairing/controllers';
import { localMeshStore } from '../../mesh/local-remote/local';
import { capsuleHash } from '../../mesh/handoff';
import { localTaskTransfers, localTransferContinuations } from '../../task-transfer';
import { localTaskNetwork } from '../runtime/configuration';
import { PeerTransferOutbox } from '../storage/outgoing';
import { networkDigest } from '../storage/private-file';
import { PeerTransferSender } from './index';

let cached: { root: string; publicKey: string; sender: PeerTransferSender; onChange?: () => void } | undefined;

/** Same durable sender is resumed by the persistent monitor after the requesting CLI exits. */
export function localPeerTransferSender(config: PeerConfig, onChange?: () => void): PeerTransferSender {
  const root = join(configDir(), 'task-network-outbox', networkDigest(config.room));
  if (cached?.root === root && cached.publicKey === config.myPublicKey) {
    if (onChange) cached.onChange = onChange;
    return cached.sender;
  }
  const store = localMeshStore(), notices = localTransferContinuations();
  const sender = new PeerTransferSender({ config, network: localTaskNetwork(config),
    outbox: new PeerTransferOutbox(root), notices, controllerAllowed: controllerPeerGate(config),
    nativeSessionId: id => localTaskTransfers().nativeSession({ sessionId: id } as SessionInfo).sessionId,
    onChange: () => { if (cached?.root === root) cached.onChange?.(); },
    recordRequest: event => {
      if (notices.notice(event.sourceSessionId)?.capsuleHash !== capsuleHash(event.payload.capsule!)) return;
      const known = store.historyEventsForProject(event.projectId);
      if (known.some(row => row.eventId === event.eventId || row.eventType === 'HANDOFF_REQUEST'
        && row.sourceSessionId === event.sourceSessionId && row.createdAt >= event.createdAt)) return;
      store.acceptEvent(event);
      if (!store.flush()) throw new Error('The transfer is waiting for the Project store.');
    },
    onResult: async (result, header) => {
      if (notices.notice(header.sourceSessionId)?.capsuleHash !== capsuleHash(header.capsule)) return;
      if (result.event.eventType === 'HANDOFF_ACCEPTED' && !result.destination) {
        throw new Error('The destination execution has not been confirmed.');
      }
      store.acceptRecoveredHandoff({ type: 'mesh.event', sessionId: header.taskId, eventId: header.eventId,
        projectId: header.projectId, taskId: header.taskId, sourceSessionId: header.sourceSessionId,
        eventType: 'HANDOFF_REQUEST', createdAt: header.createdAt, expiresAt: header.expiresAt,
        payload: { capsule: header.capsule } }, result.event, result.destination);
    } });
  cached = { root, publicKey: config.myPublicKey, sender, onChange };
  return sender;
}

export async function submitNetworkTransfer(event: MeshEvent, session: SessionInfo,
  confirm: () => Promise<boolean>, options: Pick<PeerTaskTransfer, 'automatic' | 'routing' | 'forward'> = {}): Promise<boolean> {
  if (!loadRuntimeConfig().meshEnabled) return false;
  const config = applyNetworkRoute(loadConfig(machineConfigPath()));
  const store = localMeshStore(), task = store.task(event.taskId);
  const sourceExecution = store.snapshot(event.projectId)?.executions.find(row => row.sessionId === session.sessionId
    && row.computerId === event.payload.capsule?.sourceComputer && row.endedAt == null);
  if (!task || task.projectId !== event.projectId || !sourceExecution) return false;
  return localPeerTransferSender(config).submit({ type: 'mesh.task.transfer', projectId: event.projectId,
    taskId: event.taskId, policyRevision: 0, task, sourceExecution, event, ...options }, confirm);
}
