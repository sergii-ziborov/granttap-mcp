import { z } from 'zod';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { ProjectTransportSet } from '../../../../../packages/protocol/task-network';
import { loadConfig, machineConfigPath, loadRuntimeConfig } from '../../../../bridge/src/config';
import { applyNetworkRoute } from '../../../../bridge/src/device-network/settings';
import { localMeshStore } from '../../../../bridge/src/mesh/local-remote/local';
import { TaskNetworkStore } from '../../../../bridge/src/task-network';
import { localTaskNetwork } from '../../../../bridge/src/task-network/runtime/configuration';
import { networkEnvelope } from '../../../../bridge/src/task-network/transport/ciphertext';
import { networkRequest } from '../../../../bridge/src/task-network/transport/http';
import { decodeProjectConfiguration, projectConfigurationId } from '../../../../bridge/src/task-network/configuration/ciphertext';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const Grant = z.object({ sourceKeyId: digest, recipientKeyId: digest, scopeHash: digest, tokenHash: digest,
  expiresAt: z.number().int().nonnegative() }).strict();
const Request = z.object({ action: z.enum(['descriptor', 'grant', 'configure']),
  project_id: z.string().min(1).max(128), command: z.string().max(60_000).optional(),
  writer_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/).optional(),
  grant: z.string().max(4_096).optional() }).strict();
type Options = { config?: PeerConfig; network?: TaskNetworkStore; enabled?: () => boolean;
  projectAllowed?: (id: string) => boolean; request?: typeof networkRequest };

/** Same-user administrative IPC only. No root credential or private key is returned to the UI or provider. */
export async function desktopProjectTransport(input: unknown, options: Options = {}): Promise<unknown> {
  const parsed = Request.safeParse(input);
  if (!parsed.success) return undefined;
  const request = parsed.data, config = options.config ?? applyNetworkRoute(loadConfig(machineConfigPath()));
  const network = options.network ?? localTaskNetwork(config);
  const enabled = options.enabled ?? (() => loadRuntimeConfig().meshEnabled);
  const projectAllowed = options.projectAllowed ?? (id => {
    const store = localMeshStore(), project = store.project(id);
    return Boolean(project && store.workspaceForRepository(project.canonicalRepositoryId, network.endpointId));
  });
  if (!enabled() || config.role !== 'machine' || network.publicKey !== config.myPublicKey
    || !projectAllowed(request.project_id)) return undefined;
  const operation = 'desktop.project_transport';
  if (request.action === 'descriptor') return { operation, endpoint: { id: network.endpointId,
    room: config.room, relayUrl: config.relayUrl, publicKey: config.myPublicKey } };
  const http = options.request ?? networkRequest;
  const rootRequest = { ...config, credential: config.pushAuth ?? '', method: 'PUT' as const };
  if (request.action === 'grant') {
    const grant = Grant.safeParse(parseJSON(request.grant));
    if (!request.writer_id || !grant.success || grant.data.recipientKeyId !== publicKeyIdentifier(config.myPublicKey)) return undefined;
    const result = await http({ ...rootRequest, path: `/task-job-writers/${request.writer_id}`, body: grant.data }) as
      { writer?: { id?: string } } | null;
    if (result?.writer?.id !== request.writer_id) throw new Error('The local Project writer was not confirmed.');
    return { operation, accepted: true };
  }
  const command = ProjectTransportSet.safeParse(parseJSON(request.command));
  if (!command.success || command.data.projectId !== request.project_id
    || !network.configure(command.data, `native:${config.myPublicKey}`, projectAllowed)) return undefined;
  const id = projectConfigurationId(request.project_id, network.endpointId);
  const envelope = networkEnvelope(config, { publicKey: config.myPublicKey, room: config.room,
    id, body: command.data, expiresAt: command.data.expiresAt });
  const record = { issuerKeyId: publicKeyIdentifier(config.myPublicKey), expiresAt: envelope.expiresAt, envelope };
  const response = await http({ ...rootRequest, path: `/task-job-configurations/${id}`,
    body: record, maxResponseBytes: 100_000 }) as { configuration?: unknown } | null;
  const decoded = decodeProjectConfiguration(response?.configuration, { config, endpointId: network.endpointId,
    projectId: request.project_id, now: Date.now(), controllers: [], controllerAllowed: () => false, allowNativeIssuer: true });
  if (!decoded || JSON.stringify(decoded.command) !== JSON.stringify(command.data)) {
    throw new Error('The relay has not confirmed the local Project configuration.');
  }
  return { operation, ack: { type: 'project.transport.ack', sessionId: request.project_id, projectId: request.project_id,
    targetEndpointId: network.endpointId, requestId: command.data.requestId, revision: command.data.revision,
    accepted: true, generatedAt: Date.now() } };
}

function parseJSON(value: string | undefined): unknown {
  try { return JSON.parse(value ?? ''); } catch { return undefined; }
}
