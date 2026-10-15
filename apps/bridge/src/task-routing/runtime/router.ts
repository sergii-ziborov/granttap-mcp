import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { MeshHandoffPrepare, SessionInfo } from '../../../../../packages/protocol/schema';
import type { PeerTaskTransfer } from '../../../../../packages/protocol/task-network';
import type { TaskResourceReport } from '../../../../../packages/protocol/task-resources';
import type { MeshStore } from '../../mesh/store';
import type { TaskNetworkStore } from '../../task-network';
import { readPeerResources, candidatesFromReport } from '../resources/transport';
import { selectTaskComputer } from '../index';
import type { RoutingRequest } from '../requests';

export type AutomaticPreparation = Pick<PeerTaskTransfer, 'routing' | 'forward'> & {
  eventId: string; confirmPolicy: () => Promise<boolean> };
type Options = { config: PeerConfig; network: TaskNetworkStore; store: MeshStore;
  controllerAllowed: (key: string) => boolean; enabled: () => boolean; refresh: (id: string) => Promise<boolean>;
  clean: (path: string) => boolean; observe: (projectId: string, workspace: string) => Promise<TaskResourceReport | undefined>;
  peerReport?: typeof readPeerResources; prepare: (request: MeshHandoffPrepare, input: AutomaticPreparation) => Promise<boolean>;
  requestCurrent?: (row: RoutingRequest) => boolean;
  currentSession?: (id: string) => Promise<SessionInfo | undefined>;
  now?: () => number };

/** Chooses capacity only for the attributed source; native preparation captures the full finished conversation. */
export class TaskResourceRouter {
  constructor(private readonly input: Options) {}

  async route(row: RoutingRequest, session: SessionInfo): Promise<boolean | 'wait'> {
    const { network, store } = this.input, source = row.source;
    if (!this.input.enabled()) return false;
    if (!await this.input.refresh(source.projectId)) return 'wait';
    const configuration = network.current(source.projectId, this.input.controllerAllowed);
    if (!configuration?.routingEnabled) return false;
    const snapshot = store.snapshot(source.projectId), task = store.task(source.taskId);
    const execution = snapshot?.executions.find(value => value.sessionId === source.sessionId
      && value.taskId === source.taskId && value.computerId === network.endpointId && value.endedAt == null);
    const workspace = session.worktree ?? session.cwd;
    if (!execution || !task || task.ownerSessionId !== source.sessionId && !execution.continuedAt
      || session.state !== 'idle' || session.model !== source.model || session.effort !== source.effort
      || !workspace || !this.input.clean(workspace)) return false;
    const own = await this.input.observe(source.projectId, workspace);
    if (!own) return 'wait';
    const candidates = candidatesFromReport(own, this.now(), source.provider, source.model, row.requirements.requiredTools);
    for (let offset = 0; offset < configuration.peers.length; offset += 4) {
      const reports = await Promise.allSettled(configuration.peers.slice(offset, offset + 4).map(peer =>
        (this.input.peerReport ?? readPeerResources)(this.input.config, peer,
          { projectId: source.projectId, revision: configuration.revision })));
      for (const result of reports) if (result.status === 'fulfilled' && result.value) {
        candidates.push(...candidatesFromReport(result.value.report, result.value.receivedAt,
          source.provider, source.model, row.requirements.requiredTools));
      }
    }
    const recent = store.historyEventsForProject(source.projectId).filter(event => event.taskId === source.taskId
      && event.eventType === 'HANDOFF_ACCEPTED' && event.payload.receipt && this.now() - event.payload.receipt.acceptedAt < 30 * 60_000);
    const visited = recent.flatMap(event => snapshot?.executions.filter(execution =>
      [event.payload.receipt!.sourceSessionId, event.payload.receipt!.targetSessionId].includes(execution.sessionId))
      .map(execution => execution.computerId) ?? []);
    const decision = selectTaskComputer({ now: this.now(), candidates,
      policy: { enabled: configuration.routingEnabled, revision: configuration.revision,
        allowCrossPlatform: configuration.allowCrossPlatform, cooldownMs: configuration.cooldownMs },
      request: { ...row.requirements, projectId: source.projectId, repositoryId: own.repositoryId, revision: own.revision,
        sourceEndpointId: network.endpointId, provider: source.provider, modelId: source.model, effort: source.effort,
        sourceOS: own.os, sourceArchitecture: own.architecture, visitedEndpoints: visited, hops: recent.length,
        ...(recent.length ? { lastTransferAt: Math.max(...recent.map(event => event.payload.receipt!.acceptedAt)) } : {}) } });
    if (!decision.target) return decision.reason === 'hop_limit' ? false : 'wait';
    const { reason: _reason, ...needs } = row.requirements;
    return this.input.prepare({ type: 'mesh.handoff.prepare', sessionId: source.sessionId, taskId: source.taskId,
      projectId: source.projectId, targetProvider: source.provider, targetComputer: decision.target.endpointId,
      targetModel: source.model, prepareOnly: true, checkpoint: false, push: false, createdAt: this.now() },
    { eventId: `automatic-${row.id}`, routing: { ...needs, sourceOS: own.os, sourceArchitecture: own.architecture },
      forward: { text: 'Continue this same Task from its complete saved conversation and repository facts. Carry on with the latest user request.',
        model: source.model, effort: source.effort }, confirmPolicy: async () => this.input.enabled()
          && (this.input.requestCurrent?.(row) ?? true)
          && await this.sourceCurrent(session)
          && await this.input.refresh(source.projectId)
          && network.current(source.projectId, this.input.controllerAllowed)?.createdAt === configuration.createdAt });
  }
  private async sourceCurrent(expected: SessionInfo): Promise<boolean> {
    if (!this.input.currentSession) return true;
    const current = await this.input.currentSession(expected.sessionId);
    return Boolean(current && current.agent === expected.agent && current.state === 'idle'
      && current.projectId === expected.projectId && current.taskId === expected.taskId
      && current.model === expected.model && current.effort === expected.effort
      && (current.worktree ?? current.cwd) === (expected.worktree ?? expected.cwd));
  }
  private now(): number { return (this.input.now ?? Date.now)(); }
}
