import { z } from 'zod';
import { loadConfig, loadRuntimeConfig, machineConfigPath } from '../../config';
import { applyNetworkRoute } from '../../device-network/settings';
import { scanSessions } from '../../sessions';
import { meshCatalog } from '../../mesh/runtime';
import { liveExecutionScope } from '../../mesh/catalog/capability';
import { observedComputerId } from '../../mesh/identity/computer';
import { localTaskTransfers } from '../../task-transfer';
import { controllerPeerGate } from '../../pairing/controllers';
import { localTaskNetwork } from '../../task-network/runtime/configuration';
import { localProjectConfigurationSync } from '../../task-network/configuration/runtime';
import { localRoutingRequests, RoutingRequests, RoutingRequirementsInput, type RoutingRequestSource } from '../requests';
import { observedRoutingSession } from '../observed-turn';

export const OffloadInput = z.object({ action: z.enum(['request', 'cancel', 'status']).optional(),
  operationId: z.string().trim().min(1).max(128).optional(),
  requirements: RoutingRequirementsInput.partial().extend({ reason: RoutingRequirementsInput.shape.reason }).optional() }).strict();
export type OffloadArguments = z.infer<typeof OffloadInput>;
type Proof = { sessionId: string; provider: RoutingRequestSource['provider'] };
type Ports = { store: RoutingRequests; enabled: () => boolean;
  source: (proof: Proof) => RoutingRequestSource | undefined | Promise<RoutingRequestSource | undefined>;
  allowed: (projectId: string) => Promise<boolean> };

/** Only the provider hook supplies identity. Models supply resource needs and an idempotency name. */
export async function admitTaskOffload(input: OffloadArguments, proof: Proof | undefined,
  ports: Ports = defaultPorts()): Promise<{ status: string; requestId?: string; code?: string }> {
  if (!proof) throw new Error('This resource request has no trusted provider attribution. Check the GrantTap provider hook.');
  const args = OffloadInput.parse(input), source = await ports.source(proof);
  if (!source || source.provider !== proof.provider) throw new Error('The current Task execution could not be confirmed.');
  if (args.action === 'cancel') return { status: ports.store.cancel(source.sessionId) ? 'cancelled' : 'not_pending' };
  if (args.action === 'status') {
    const row = ports.store.latest(source.sessionId);
    return { status: row?.phase ?? 'not_pending', requestId: row?.id, code: row?.code };
  }
  if (!ports.enabled() || !await ports.allowed(source.projectId)) {
    throw new Error('Automatic computer transfers need fresh, enabled Project permission in GrantTap.');
  }
  if (!source.model) throw new Error('The provider has not confirmed this execution\'s current model.');
  if (source.provider !== 'cursor' && !source.effort) {
    throw new Error('The provider has not reported this execution\'s current reasoning effort. It cannot be preserved yet.');
  }
  if (!args.operationId || !args.requirements) throw new Error('Provide operationId and explicit resource requirements.');
  const row = ports.store.request(args.operationId, source, RoutingRequirementsInput.parse(args.requirements));
  return { status: row.phase, requestId: row.id, code: row.code };
}

function defaultPorts(): Ports {
  return { store: localRoutingRequests(), enabled: () => loadRuntimeConfig().meshEnabled,
    source: async proof => {
      const transferred = localTaskTransfers().executionForNative(proof.provider, proof.sessionId);
      const id = transferred?.sessionId ?? proof.sessionId;
      const session = meshCatalog(scanSessions().sessions).find(row => row.sessionId === id);
      const scope = liveExecutionScope(id), execution = scope?.execution;
      const task = scope?.snapshot.tasks.find(row => row.taskId === execution?.taskId);
      if (!session || !scope || execution?.computerId !== observedComputerId() || execution.provider !== proof.provider
        || !task || task.ownerSessionId !== id && !execution.continuedAt) return undefined;
      const observed = await observedRoutingSession(session);
      return { sessionId: id, ...(id !== proof.sessionId ? { nativeSessionId: proof.sessionId } : {}),
        provider: proof.provider, projectId: scope.snapshot.projectId, taskId: task.taskId,
        model: observed.model ?? '', effort: observed.effort };
    },
    allowed: async projectId => {
      const config = applyNetworkRoute(loadConfig(machineConfigPath()));
      return await localProjectConfigurationSync(config).refresh(projectId)
        && localTaskNetwork(config).current(projectId, controllerPeerGate(config))?.routingEnabled === true;
    } };
}
