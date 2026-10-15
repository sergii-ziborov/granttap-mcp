import { randomBytes } from 'node:crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import type { MeshEvent } from '../../../../../packages/protocol/schema';
import { PeerTaskDispatch, PeerTaskTransfer, type PeerTaskResult } from '../../../../../packages/protocol/task-network';
import type { TaskNetworkStore } from '../index';
import type { TransferContinuations } from '../../task-transfer';
import { capsuleHash } from '../../mesh/handoff';
import { PeerTransferOutbox, type OutgoingPeerTransfer } from '../storage/outgoing';
import { networkDigest } from '../storage/private-file';
import { peerJobBody, openPeerResult } from '../transport/ciphertext';
import { peerJobRequest, type PeerJobReceipt } from '../transport/http';

type ResultContext = Pick<OutgoingPeerTransfer, 'id' | 'projectId' | 'taskId' | 'sourceSessionId'
  | 'capsule' | 'eventId' | 'createdAt' | 'expiresAt' | 'targetEndpointId'>;
type Options = { config: PeerConfig; network: TaskNetworkStore; outbox: PeerTransferOutbox;
  notices: TransferContinuations; controllerAllowed: (key: string) => boolean;
  recordRequest: (event: MeshEvent) => unknown | Promise<unknown>;
  onResult: (result: PeerTaskResult, context: ResultContext) => Promise<void>;
  nativeSessionId?: (id: string) => string; remote?: typeof peerJobRequest;
  now?: () => number; onChange?: () => void;
  onError?: (id: string, code: 'relay_unavailable' | 'invalid_receipt' | 'expired' | 'policy_changed') => void };

/** Persists admission before upload and applies only the selected computer's authenticated result. */
export class PeerTransferSender {
  private busy = false;
  private readonly remote: typeof peerJobRequest;
  private readonly now: () => number;
  constructor(private readonly input: Options) { this.remote = input.remote ?? peerJobRequest; this.now = input.now ?? Date.now; }

  hasDurableRequest(projectId: string, eventId: string): boolean {
    const id = `peer-transfer-${networkDigest([projectId, eventId, this.input.config.myPublicKey]).slice(0, 48)}`;
    try { return ['uploading', 'queued', 'accepted', 'completed'].includes(this.input.outbox.header(id).state); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async submit(input: PeerTaskTransfer, confirmContext: () => Promise<boolean>): Promise<boolean> {
    const operation = PeerTaskTransfer.parse(input), capsule = operation.event.payload.capsule!;
    const configuration = this.input.network.current(operation.projectId, this.input.controllerAllowed, this.now());
    const peer = configuration?.peers.find(value => value.endpointId === capsule.targetComputer);
    if (!configuration || !peer || peer.outgoing.expiresAt <= this.now()
      || operation.automatic && !configuration.routingEnabled) return false;
    if (this.input.config.role !== 'machine' || this.input.config.myPublicKey !== this.input.network.publicKey
      || capsule.sourceComputer !== this.input.network.endpointId) throw new Error('Transfer source computer scope mismatch.');
    const createdAt = Math.floor(operation.event.createdAt);
    const expiresAt = Math.min(configuration.expiresAt, peer.outgoing.expiresAt, createdAt + 30 * 86_400_000);
    const transferred = { ...operation, policyRevision: configuration.revision,
      event: { ...operation.event, createdAt, expiresAt } };
    const job = PeerTaskDispatch.parse({ type: 'mesh.task.dispatch', jobId: `peer-transfer-${networkDigest([
      operation.projectId, operation.event.eventId, this.input.config.myPublicKey]).slice(0, 48)}`,
      token: randomBytes(32).toString('hex'), notBefore: createdAt, expiresAt, createdAt, operation: transferred });
    let header = this.input.outbox.stage({ id: job.jobId, projectId: operation.projectId, taskId: operation.taskId,
      eventId: operation.event.eventId, sourceSessionId: operation.event.sourceSessionId, capsule,
      targetEndpointId: peer.endpointId, peer, writerId: peer.outgoing.writerId, revision: configuration.revision,
      createdAt, expiresAt, ...(operation.automatic ? { automatic: true } : {}) },
    transferred, () => peerJobBody(this.input.config, peer, job));
    if (header.state === 'drafting') {
      this.input.notices.record({ phase: 'pending', sourceSessionId: header.sourceSessionId,
        projectId: header.projectId, taskId: header.taskId, capsuleHash: capsuleHash(header.capsule),
        queuedAt: header.createdAt, targetComputerId: header.targetEndpointId, targetProvider: header.capsule.targetProvider },
      this.input.nativeSessionId?.(header.sourceSessionId));
      let confirmed = false;
      try { confirmed = await confirmContext(); }
      catch { this.failDraft(header); throw new Error('The source capture could not be reconfirmed. No context was uploaded.'); }
      if (!confirmed || !this.canUpload(header)) {
        this.failDraft(header);
        throw new Error('The source changed after capture, or its Project grant changed. No context was uploaded.');
      }
      header = this.input.outbox.activate(header.id);
      if (header.state === 'failed') throw new Error('The unconfirmed transfer draft expired. Prepare the transfer again.');
    }
    if (['completed', 'failed'].includes(header.state)) return true;
    try { await this.input.recordRequest(this.requestMetadata(header)); await this.reconcile(header); }
    catch { this.input.onError?.(header.id, 'relay_unavailable'); }
    this.input.onChange?.();
    return true;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = this.input.outbox.pending();
      for (let from = 0; from < rows.length; from += 4) {
        await Promise.all(rows.slice(from, from + 4).map(async row => {
          try { await this.reconcile(row); } catch { this.input.onError?.(row.id, 'relay_unavailable'); }
        }));
      }
    } finally { this.busy = false; }
  }

  private async reconcile(input: OutgoingPeerTransfer): Promise<void> {
    let header = this.input.outbox.header(input.id);
    if (header.state === 'drafting') {
      // A notice proves the source guard was saved, not that capture was reconfirmed.
      // Only submit() may cross this durable admission boundary.
      if (this.now() - header.createdAt > 60_000) this.failDraft(header);
      return;
    }
    if (['completed', 'failed'].includes(header.state)) return;
    if (this.now() > header.expiresAt + 7 * 86_400_000) {
      this.input.outbox.state(header.id, 'failed'); this.input.onError?.(header.id, 'expired'); return;
    }
    await this.input.recordRequest(this.requestMetadata(header));
    const upload = header.state === 'uploading' && this.canUpload(header);
    const receipt = await this.remote(header.peer, header.id, upload ? 'PUT' : 'GET', upload ? this.input.outbox.body(header.id) : undefined);
    await this.acceptReceipt(header, receipt);
  }

  private async acceptReceipt(header: OutgoingPeerTransfer, receipt: PeerJobReceipt): Promise<void> {
    if (receipt.id !== header.id) throw new Error('Transfer receipt identity mismatch.');
    if (receipt.resultEnvelope) {
      const result = openPeerResult(receipt.resultEnvelope, this.input.config, header.peer,
        { jobId: header.id, projectId: header.projectId, taskId: header.taskId,
          retainedUntil: header.expiresAt + 7 * 86_400_000 }, this.now());
      const accepted = result?.event.payload.receipt;
      if (!result || result.event.targetSessionId !== header.sourceSessionId
        || receipt.state !== (result.event.eventType === 'HANDOFF_ACCEPTED' ? 'completed' : 'failed')
        || result.event.eventType === 'HANDOFF_REJECTED' && accepted != null
        || result.event.eventType === 'HANDOFF_ACCEPTED' && (!accepted?.prepared
          || accepted.sourceSessionId !== header.sourceSessionId || accepted.taskId !== header.taskId
          || accepted.capsuleHash !== capsuleHash(header.capsule) || result.event.sourceSessionId !== accepted.targetSessionId
          || !result.destination || result.destination.computerId !== header.targetEndpointId
          || result.destination.provider !== header.capsule.targetProvider)) {
        this.input.onError?.(header.id, 'invalid_receipt'); return;
      }
      if (accepted) this.input.notices.record({ sourceSessionId: header.sourceSessionId,
        projectId: header.projectId, taskId: header.taskId, capsuleHash: accepted.capsuleHash,
        targetSessionId: accepted.targetSessionId, acceptedAt: accepted.acceptedAt, queuedAt: header.createdAt,
        targetComputerId: header.targetEndpointId, targetProvider: header.capsule.targetProvider }, this.input.nativeSessionId?.(header.sourceSessionId));
      const { peer: _peer, writerId: _writer, intent: _intent, state: _state, ...context } = header;
      await this.input.onResult(result, context);
      if (!accepted) this.input.notices.withdrawPending(this.consent(header));
      this.input.outbox.state(header.id, accepted ? 'completed' : 'failed');
      this.input.onChange?.(); return;
    }
    if (receipt.state === 'queued' || receipt.state === 'accepted') this.input.outbox.state(header.id, receipt.state);
    else this.input.onError?.(header.id, 'invalid_receipt');
  }

  private canUpload(header: OutgoingPeerTransfer): boolean {
    const current = this.input.network.current(header.projectId, this.input.controllerAllowed, this.now());
    return current?.revision === header.revision && (!header.automatic || current.routingEnabled) && current.peers.some(peer =>
      peer.endpointId === header.targetEndpointId && peer.outgoing.writerId === header.writerId && peer.outgoing.expiresAt > this.now()) === true;
  }

  private requestMetadata(header: OutgoingPeerTransfer): MeshEvent {
    return { type: 'mesh.event', sessionId: header.taskId, eventId: header.eventId, projectId: header.projectId,
      taskId: header.taskId, sourceSessionId: header.sourceSessionId, eventType: 'HANDOFF_REQUEST',
      createdAt: header.createdAt, expiresAt: header.expiresAt, payload: { capsule: header.capsule } };
  }

  private consent(header: OutgoingPeerTransfer) {
    return { sessionId: header.sourceSessionId, projectId: header.projectId, taskId: header.taskId, capsuleHash: capsuleHash(header.capsule) };
  }
  private failDraft(header: OutgoingPeerTransfer): void {
    if (!this.input.outbox.discardDraft(header.id)) return;
    this.input.notices.withdrawPending(this.consent(header));
    this.input.onChange?.();
  }
}
