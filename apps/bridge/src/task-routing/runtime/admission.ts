import type { PeerTaskTransfer, ProjectTransportSet } from '../../../../../packages/protocol/task-network';
import type { TaskResourceReport } from '../../../../../packages/protocol/task-resources';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { candidatesFromReport } from '../resources/transport';
import { routingAdmissionReason } from '../index';
import { controllerPeerGate } from '../../pairing/controllers';
import { localTaskNetwork } from '../../task-network/runtime/configuration';
import { localProjectConfigurationSync } from '../../task-network/configuration/runtime';
import { observeRoutingComputer } from './observation';

export function automaticTransferAdmissionReason(operation: PeerTaskTransfer, report: TaskResourceReport,
  configuration: ProjectTransportSet, now = Date.now()): string | undefined {
  const needs = operation.routing, capsule = operation.event.payload.capsule!;
  if (!operation.automatic || !needs || !capsule.targetModel || capsule.targetProvider === 'grok_bot') return 'routing_scope';
  if (configuration.projectId !== operation.projectId || configuration.revision !== operation.policyRevision
    || report.projectId !== operation.projectId || report.endpointId !== configuration.targetEndpointId
    || capsule.targetComputer !== report.endpointId) return 'project_scope';
  if (report.expiresAt <= now || configuration.expiresAt <= now) return 'computer_unavailable';
  const candidate = candidatesFromReport(report, now, capsule.targetProvider, capsule.targetModel, needs.requiredTools)[0]!;
  return routingAdmissionReason(candidate, { ...needs, projectId: operation.projectId, repositoryId: capsule.repository,
    revision: capsule.latestCommit ?? capsule.baseSha, sourceEndpointId: operation.sourceExecution.computerId,
    provider: capsule.targetProvider, modelId: capsule.targetModel, effort: operation.forward?.effort,
    sourceOS: needs.sourceOS, sourceArchitecture: needs.sourceArchitecture, reason: 'required_hardware' },
  { enabled: configuration.enabled && configuration.routingEnabled, revision: configuration.revision,
    allowCrossPlatform: configuration.allowCrossPlatform, cooldownMs: configuration.cooldownMs }, now);
}

export async function admitAutomaticNetworkTransfer(config: PeerConfig, operation: PeerTaskTransfer): Promise<boolean> {
  const report = await observeRoutingComputer(config, operation.projectId);
  if (!report) return false;
  // Measurement is asynchronous; revoke/disable is fetched again before any work is prepared.
  if (!await localProjectConfigurationSync(config).refresh(operation.projectId)) {
    throw new Error('The Project permission could not be refreshed after measuring capacity.');
  }
  const configuration = localTaskNetwork(config).current(operation.projectId, controllerPeerGate(config));
  return Boolean(configuration && !automaticTransferAdmissionReason(operation, report, configuration));
}
