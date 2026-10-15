import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { requestTaskJob } from '../../../../../packages/core/task-job-http';
import type { TaskJobRemote } from './index';

/** The opaque job token proves that this receiver decrypted the intended operation. */
export function relayTaskJobRemote(config: PeerConfig, request: typeof fetch = fetch): TaskJobRemote {
  const recipientKeyId = publicKeyIdentifier(config.myPublicKey);
  return {
    get: async job => (await requestTaskJob(config, { id: job.jobId, method: 'GET' }, request))?.state ?? 'expired',
    claim: async (job, claimId) => (await requestTaskJob(config, { id: job.jobId, method: 'POST', action: 'claim',
      body: { token: job.token, recipientKeyId, claimId } }, request))?.state === 'accepted',
    finish: async (job, state, resultCode, claimId) => {
      if (!claimId) throw new Error('A durable receiver attempt was not recorded.');
      const current = await requestTaskJob(config, { id: job.jobId, method: 'POST', action: 'finish',
        body: { token: job.token, recipientKeyId, claimId, state, ...(resultCode ? { resultCode } : {}) } }, request);
      if (current?.state !== state) throw new Error('Relay has not confirmed the task outcome');
    },
  };
}
