import { Envelope } from '../../../../../packages/protocol/schema';
import { PeerTaskDispatch } from '../../../../../packages/protocol/task-network';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { open } from '../../../../../packages/core/crypto';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import type { TaskNetworkStore } from '../index';

/** Only this dedicated queue decoder accepts a computer peer. Ordinary controller decoding stays unchanged. */
export function openPeerTaskOffer(control: unknown, config: PeerConfig, store: TaskNetworkStore,
  controllerAllowed: (publicKey: string) => boolean, now = Date.now()) {
  if (!control || typeof control !== 'object' || !('type' in control) || control.type !== 'relay.task-job'
    || !('job' in control) || !control.job || typeof control.job !== 'object') return undefined;
  const offered = control.job as Record<string, unknown>;
  if (offered.state !== 'queued' || typeof offered.writerId !== 'string') return undefined;
  const grant = store.incoming(offered.writerId, controllerAllowed, now);
  if (!grant) return undefined;
  const envelope = Envelope.safeParse(offered.envelope);
  if (!envelope.success) return undefined;
  const env = envelope.data;
  if (env.room !== config.room || env.to !== 'machine' || env.deliveryId !== offered.id
    || env.expiresAt !== offered.expiresAt || env.recipientKeyId !== publicKeyIdentifier(config.myPublicKey)) return undefined;
  const parsed = PeerTaskDispatch.safeParse(open(env.nonce, env.box, grant.peer.publicKey, config.mySecretKey));
  if (!parsed.success) return undefined;
  const job = parsed.data, operation = job.operation, capsule = operation.event.payload.capsule!;
  if (job.jobId !== offered.id || job.expiresAt !== offered.expiresAt || job.notBefore !== offered.notBefore
    || job.expiresAt <= now || job.notBefore > now || job.expiresAt > grant.configuration.expiresAt
    || operation.projectId !== grant.configuration.projectId || operation.policyRevision !== grant.configuration.revision
    || operation.sourceExecution.computerId !== grant.peer.endpointId || capsule.targetComputer !== store.endpointId) return undefined;
  return { job, peer: grant.peer, configuration: grant.configuration };
}
