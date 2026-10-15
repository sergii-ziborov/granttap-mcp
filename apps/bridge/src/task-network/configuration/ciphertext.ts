import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PeerConfig } from '../../../../../packages/core/relay-client';
import { open } from '../../../../../packages/core/crypto';
import { publicKeyIdentifier } from '../../../../../packages/core/ciphertext-recipient';
import { Envelope } from '../../../../../packages/protocol/schema';
import { ProjectTransportSet } from '../../../../../packages/protocol/task-network';

export const projectConfigurationId = (projectId: string, endpointId: string): string =>
  createHash('sha256').update(JSON.stringify(['granttap-project-transport-v1', projectId, endpointId])).digest('hex');

const Record = z.object({ id: z.string(), issuerKeyId: z.string(), expiresAt: z.number(), envelope: Envelope }).passthrough();
type Input = { config: PeerConfig; endpointId: string; projectId: string; controllers: string[];
  controllerAllowed: (key: string) => boolean; now: number; allowNativeIssuer?: boolean };

/** A configuration mailbox grants only Project transport authority, never controller access. */
export function decodeProjectConfiguration(raw: unknown, input: Input):
  { command: ProjectTransportSet; issuer: string } | undefined {
  const parsed = Record.safeParse(raw);
  if (!parsed.success) return undefined;
  const { config, now } = input, record = parsed.data, env = record.envelope;
  const id = projectConfigurationId(input.projectId, input.endpointId);
  if (record.id !== id || env.deliveryId !== id || env.room !== config.room || env.to !== 'machine'
    || env.recipientKeyId !== publicKeyIdentifier(config.myPublicKey) || env.expiresAt !== record.expiresAt
    || record.expiresAt <= now || record.expiresAt > now + 30 * 86_400_000) return undefined;
  const candidates = env.from === 'phone'
    ? [...new Set(input.controllers)].filter(key => input.controllerAllowed(key)).map(key => ({ key, issuer: key }))
    : env.from === 'machine' && input.allowNativeIssuer
      ? [{ key: config.myPublicKey, issuer: `native:${config.myPublicKey}` }] : [];
  const issuer = candidates.find(candidate => publicKeyIdentifier(candidate.key) === record.issuerKeyId);
  if (!issuer) return undefined;
  const command = ProjectTransportSet.safeParse(open(env.nonce, env.box, issuer.key, config.mySecretKey));
  if (!command.success || command.data.projectId !== input.projectId
    || command.data.targetEndpointId !== input.endpointId || command.data.expiresAt !== record.expiresAt) return undefined;
  return { command: command.data, issuer: issuer.issuer };
}
