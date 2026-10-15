import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import { PeerTaskDispatch, ProjectTransportSet, type TaskNetworkPeer } from '../../../../../packages/protocol/task-network';
import { TaskNetworkStore, taskNetworkScope } from '../index';

export function networkFixture() {
  const root = mkdtempSync(join(tmpdir(), 'granttap-network-'));
  const source = generateKeyPair(), target = generateKeyPair(), controller = generateKeyPair(), now = Date.now();
  const sourceConfig = { myPublicKey: source.publicKey, mySecretKey: source.secretKey, peerPublicKey: controller.publicKey,
    role: 'machine' as const, relayUrl: 'wss://relay.test', room: 'b'.repeat(32), senderId: 'source', deviceName: 'Source' };
  const targetConfig = { ...sourceConfig, myPublicKey: target.publicKey, mySecretKey: target.secretKey,
    room: 'a'.repeat(32), senderId: 'target', deviceName: 'Target' };
  const peer: TaskNetworkPeer = { endpointId: 'target', publicKey: target.publicKey,
    incomingWriterId: 'target-to-source', outgoing: { relayUrl: targetConfig.relayUrl, room: targetConfig.room,
      writerId: 'source-to-target', secret: 'c'.repeat(64), expiresAt: now + 60_000,
      scopeHash: taskNetworkScope('project', 'source', 'target', 1) } };
  const targetNetwork = ProjectTransportSet.parse({ type: 'project.transport.set', sessionId: 'project', projectId: 'project',
    targetEndpointId: 'target', requestId: 'request', revision: 1, createdAt: now, enabled: true,
    expiresAt: now + 60_000, allowCrossPlatform: false, cooldownMs: 60_000,
    peers: [{ endpointId: 'source', publicKey: source.publicKey, incomingWriterId: 'source-to-target',
      outgoing: { relayUrl: sourceConfig.relayUrl, room: sourceConfig.room, writerId: 'target-to-source',
        secret: 'd'.repeat(64), expiresAt: now + 60_000, scopeHash: taskNetworkScope('project', 'target', 'source', 1) } }] });
  const store = new TaskNetworkStore(join(root, 'peers'), 'target', target.publicKey);
  store.configure(targetNetwork, controller.publicKey, () => true, now);
  const context = 'Synthetic visible conversation', contextHash = createHash('sha256').update(context).digest('hex');
  const job = PeerTaskDispatch.parse({ type: 'mesh.task.dispatch', jobId: 'peer-transfer-0001', token: 'e'.repeat(64),
    notBefore: now, expiresAt: now + 30_000, createdAt: now,
    operation: { type: 'mesh.task.transfer', projectId: 'project', taskId: 'task', policyRevision: 1,
      task: { taskId: 'task', projectId: 'project', title: 'Task', goal: 'Synthetic task', state: 'working',
        ownerSessionId: 'source-chat', createdAt: now, updatedAt: now },
      sourceExecution: { taskId: 'task', sessionId: 'source-chat', provider: 'codex', computerId: 'source', workspace: '/fixture', startedAt: now },
      event: { type: 'mesh.event', sessionId: 'task', eventId: 'transfer-event', projectId: 'project', taskId: 'task',
        sourceSessionId: 'source-chat', eventType: 'HANDOFF_REQUEST', createdAt: now,
        payload: { transferContext: context, capsule: { taskId: 'task', title: 'Task', launch: 'on_message', contextHash,
          goal: 'Synthetic task', currentStatus: 'Ready', sourceProvider: 'codex', sourceComputer: 'source', targetProvider: 'grok',
          targetComputer: 'target', repository: 'repo', baseSha: 'a'.repeat(40), workingTree: 'clean', filesChanged: [],
          dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [], createdAt: now } } } } });
  return { root, source, target, controller, now, sourceConfig, targetConfig, peer, targetNetwork, store, job,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
