import { createHash } from 'node:crypto';
import { Envelope, Payload } from '../../protocol/schema';
import type { PeerConfig } from '../relay-client-types';
import { publicKeyIdentifier } from '../ciphertext-recipient';
import { openFromPeersWithIdentity, openWithTransferKey } from '../crypto';

/** Authenticate routing, peer identity and optional task encryption before consumers run. */
export function openRelayMessage(cfg: PeerConfig, raw: unknown, sessionKeys: Map<string, string>,
  peerAllowed: (key: string) => boolean) {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) return undefined;
  const env = parsed.data;
  if (env.room !== cfg.room || (env.recipientKeyId
    && env.recipientKeyId !== publicKeyIdentifier(cfg.myPublicKey))) return undefined;
  if (env.from !== (cfg.role === 'machine' ? 'phone' : 'machine')
    || (env.to !== cfg.role && env.to !== 'all')) return undefined;
  if (env.expiresAt != null && env.expiresAt <= Date.now()) return undefined;
  const opened = openFromPeersWithIdentity(env.nonce, env.box, cfg.mySecretKey,
    cfg.peerPublicKey, cfg.extraPeerPublicKeys);
  if (!opened || !peerAllowed(opened.peerPublicKey)) return undefined;
  const parsedPayload = Payload.safeParse(opened.body);
  if (!parsedPayload.success) {
    const body = opened.body;
    if (body && typeof body === 'object' && 'type' in body && body.type === 'pairing.join') {
      const paths = parsedPayload.error.issues.map(issue => `${issue.path.join('.')}:${issue.code}`);
      console.error(`[granttap] dropped pairing.join (${paths.join(',') || 'invalid'})`);
    }
    return undefined;
  }
  const payload = unwrapTaskPayload(parsedPayload.data, cfg.role, sessionKeys);
  if (!payload) return undefined;
  const fingerprint = createHash('sha256').update(env.nonce).update('.').update(env.box).digest('base64url');
  return { env, payload, peerPublicKey: opened.peerPublicKey, fingerprint };
}

function unwrapTaskPayload(payload: Payload, role: string, sessionKeys: Map<string, string>): Payload | undefined {
  if (payload.type === 'session.key.grant') {
    if (role === 'machine' && !['task', 'project'].includes(payload.purpose ?? '')) return undefined;
    return payload;
  }
  if (payload.type !== 'session.sealed') return payload;
  const key = sessionKeys.get(payload.sessionId);
  if (!key) return undefined;
  const inner = Payload.safeParse(openWithTransferKey(payload.nonce, payload.box, key));
  if (!inner.success || inner.data.type === 'session.key.grant' || inner.data.type === 'session.sealed') return undefined;
  const sessionId = 'sessionId' in inner.data ? inner.data.sessionId : undefined;
  if (!payload.sessionId.trim() || typeof sessionId !== 'string' || !sessionId.trim()
    || sessionId !== payload.sessionId) return undefined;
  return inner.data;
}
