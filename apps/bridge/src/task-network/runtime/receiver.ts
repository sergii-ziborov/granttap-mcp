import { randomUUID } from 'node:crypto';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { PeerTaskResult, type PeerTaskDispatch, type PeerTaskTransfer } from '../../../../../packages/protocol/task-network';
import type { TaskNetworkStore } from '../index';
import { PeerTransferInbox, type IncomingPeerTransfer } from '../storage/incoming';
import { openPeerTaskOffer } from '../transport/receive';
import { networkEnvelope } from '../transport/ciphertext';
import { receiverJobRequest, type PeerJobReceipt } from '../transport/http';

type RemoteProof = Parameters<typeof receiverJobRequest>[3];
type Options = {
  config: PeerConfig; store: TaskNetworkStore; inbox: PeerTransferInbox;
  controllerAllowed: (key: string) => boolean; enabled: () => boolean; online: () => boolean;
  prepare: (job: PeerTaskDispatch) => Promise<PeerTaskResult>;
  recover?: (job: PeerTaskDispatch) => Promise<PeerTaskResult>;
  refreshConfiguration?: (projectId: string) => Promise<boolean>;
  admitAutomatic?: (operation: PeerTaskTransfer) => Promise<boolean>;
  remote?: (id: string, action: 'claim' | 'finish', proof: RemoteProof) => Promise<PeerJobReceipt>;
  onChange?: () => void; onError?: () => void;
};

/** Native work is prepared idempotently; forwarded work must use its own durable native queue ID. */
export class PeerTransferReceiver {
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private busy = false;
  private readonly remote: NonNullable<Options['remote']>;
  constructor(private readonly input: Options) {
    this.remote = input.remote ?? ((id, action, proof) => receiverJobRequest(input.config, id, action, proof));
  }

  offer(control: unknown): void {
    if (!this.input.enabled() || !this.input.online()) return;
    const opened = openPeerTaskOffer(control, this.input.config, this.input.store, this.input.controllerAllowed);
    if (!opened) return;
    this.input.inbox.stage(opened.job, opened.peer.publicKey, opened.peer.incomingWriterId);
    void this.tick().catch(() => this.input.onError?.());
  }

  async tick(): Promise<void> {
    if (this.busy || !this.input.online()) return;
    this.busy = true;
    try {
      for (const header of this.input.inbox.pending()) {
        try { await this.process(header); } catch { this.input.onError?.(); }
      }
    } finally { this.busy = false; }
  }

  private async process(header: IncomingPeerTransfer): Promise<void> {
    const { inbox, config } = this.input;
    if (header.phase === 'result') return this.finish(header);
    if (!inbox.acquire(header.id, this.owner)) return;
    const { job, peerPublicKey } = inbox.record(header.id);
    const proof = { token: job.token, claimId: header.claimId, recipientKeyId: publicKeyIdentifier(config.myPublicKey) };
    const claim = await this.remote(header.id, 'claim', proof);
    if (claim.state !== 'accepted') return;
    if ((job.operation.automatic || this.input.refreshConfiguration)
      && !await this.input.refreshConfiguration?.(job.operation.projectId)) {
      throw new Error('Computer transfer is waiting for fresh Project permission.');
    }
    const grant = this.input.store.incoming(header.writerId, this.input.controllerAllowed);
    let allowed = this.input.enabled() && grant?.peer.publicKey === peerPublicKey
      && grant.configuration.projectId === job.operation.projectId
      && grant.configuration.revision === job.operation.policyRevision
      && (!job.operation.automatic || grant.configuration.routingEnabled);
    if (allowed && job.operation.automatic) allowed = await this.input.admitAutomatic?.(job.operation) === true;
    let result: PeerTaskResult;
    if (allowed) {
      inbox.beginPreparation(header.id, this.owner);
      result = PeerTaskResult.parse(await this.input.prepare(job));
    } else if (header.preparationStarted) {
      if (!this.input.recover) throw new Error('Transfer preparation needs an existing-state recovery check.');
      result = PeerTaskResult.parse(await this.input.recover(job));
    } else { result = this.refusal(job); }
    if (result.jobId !== job.jobId || result.projectId !== job.operation.projectId || result.taskId !== job.operation.taskId) {
      throw new Error('Peer transfer preparation returned another Task scope.');
    }
    const accepted = result.event.eventType === 'HANDOFF_ACCEPTED';
    const envelope = networkEnvelope(config, { publicKey: peerPublicKey, room: config.room,
      body: result, id: job.jobId, expiresAt: Date.now() + 7 * 86_400_000 });
    inbox.saveResult(header.id, this.owner, { envelope, body: result, accepted,
      ...(accepted ? {} : { code: 'policy_denied' }) });
    this.input.onChange?.();
    await this.finish(inbox.header(header.id));
  }

  private async finish(header: IncomingPeerTransfer): Promise<void> {
    const { inbox, config } = this.input, { job } = inbox.record(header.id);
    let result = inbox.result(header.id);
    if (result.body && (result.envelope.expiresAt ?? 0) <= Date.now() + 60_000) {
      inbox.refreshResult(header.id, networkEnvelope(config, { publicKey: header.peerPublicKey,
        room: config.room, body: result.body, id: header.id, expiresAt: Date.now() + 7 * 86_400_000 }));
      result = inbox.result(header.id);
    }
    const state = result.accepted ? 'completed' : 'failed';
    const receipt = await this.remote(header.id, 'finish', { token: job.token, claimId: header.claimId,
      recipientKeyId: publicKeyIdentifier(config.myPublicKey), state, resultCode: result.code, resultEnvelope: result.envelope });
    if (receipt.state !== state) throw new Error('Peer transfer outcome was not confirmed.');
    inbox.complete(header.id);
    this.input.onChange?.();
  }

  private refusal(job: PeerTaskDispatch): PeerTaskResult {
    const operation = job.operation, now = Date.now();
    return PeerTaskResult.parse({ type: 'mesh.task.result', jobId: job.jobId,
      projectId: operation.projectId, taskId: operation.taskId, event: { type: 'mesh.event',
        sessionId: operation.taskId, eventId: randomUUID(), projectId: operation.projectId,
        taskId: operation.taskId, sourceSessionId: `computer:${this.input.store.endpointId}`,
        targetSessionId: operation.event.sourceSessionId, eventType: 'HANDOFF_REJECTED', createdAt: now,
        expiresAt: now + 86_400_000, payload: { failed: true, needsUser: true,
          reason: 'This Project no longer permits the computer transfer.' } } });
  }
}
