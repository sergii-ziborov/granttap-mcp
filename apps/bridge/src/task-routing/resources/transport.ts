import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { Envelope } from '../../../../../packages/protocol/schema';
import { TaskResourceReport } from '../../../../../packages/protocol/task-resources';
import type { TaskNetworkPeer } from '../../../../../packages/protocol/task-network';
import { open } from '../../../../../packages/core/crypto';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { networkEnvelope } from '../../task-network/transport/ciphertext';
import { networkRequest, peerCredential } from '../../task-network/transport/http';
import type { RoutingCandidate } from '../index';

export async function publishPeerResources(config: PeerConfig, peer: TaskNetworkPeer,
  input: TaskResourceReport, request = networkRequest): Promise<void> {
  const report = TaskResourceReport.parse(input);
  const envelope = networkEnvelope(config, { publicKey: peer.publicKey, room: config.room,
    body: report, id: `resources-${report.generatedAt}`, expiresAt: report.expiresAt });
  await request({ relayUrl: config.relayUrl, room: config.room, credential: config.pushAuth ?? '',
    path: `/task-resources/${peer.incomingWriterId}`, method: 'PUT', body: { envelope } });
}

export async function readPeerResources(config: PeerConfig, peer: TaskNetworkPeer,
  expected: { projectId: string; revision: number }, request = networkRequest, now = Date.now()):
  Promise<{ report: TaskResourceReport; receivedAt: number } | undefined> {
  const raw = await request({ ...peer.outgoing, credential: peerCredential(peer),
    path: `/task-resources/${peer.outgoing.writerId}`, method: 'GET' });
  const parsed = Envelope.safeParse((raw as { envelope?: unknown })?.envelope);
  if (!parsed.success) return undefined;
  const env = parsed.data;
  if (env.room !== peer.outgoing.room || env.to !== 'machine' || env.from !== 'machine'
    || env.recipientKeyId !== publicKeyIdentifier(config.myPublicKey)) return undefined;
  const decoded = TaskResourceReport.safeParse(open(env.nonce, env.box, peer.publicKey, config.mySecretKey));
  if (!decoded.success) return undefined;
  const report = decoded.data;
  return report.projectId === expected.projectId && report.endpointId === peer.endpointId
    && report.policyRevision === expected.revision && report.expiresAt === env.expiresAt
    && report.expiresAt > now && report.generatedAt <= now + 5_000 && now - report.generatedAt <= 90_000
    ? { report, receivedAt: now } : undefined;
}

export function candidatesFromReport(report: TaskResourceReport, receivedAt: number,
  provider: RoutingCandidate['provider'], modelId: string, tools: string[]): RoutingCandidate[] {
  const native = report.providers.find(row => row.provider === provider);
  const model = native?.models.find(row => row.id === modelId);
  return [{ endpointId: report.endpointId, projectId: report.projectId, repositoryId: report.repositoryId,
    revision: report.revision, revisions: report.revisions, observedAt: report.generatedAt, receivedAt, online: true,
    routingEnabled: report.routingEnabled, policyRevision: report.policyRevision, os: report.os,
    architecture: report.architecture, cpuUtilization: report.cpuUtilization,
    availableMemoryBytes: report.availableMemoryBytes, availableDiskBytes: report.availableDiskBytes,
    gpu: report.gpu, provider, providerReady: native?.ready === true,
    modelId, modelConfirmed: model != null, modelObservedAt: model?.observedAt ?? 0,
    supportedEfforts: model?.efforts, requiredToolsPresent: tools.every(tool => report.tools.includes(tool)),
    quotaExhausted: native?.quotaExhausted }];
}
