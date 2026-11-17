import { createHash } from 'node:crypto';
import { Envelope, Payload } from '../../protocol/schema';
import type { PeerConfig } from '../relay-client-types';
import { publicKeyIdentifier } from '../ciphertext-recipient';
import { openFromPeersWithIdentity, openWithTransferKey } from '../crypto';

/** Invalid control frames have no routing or delivery effect. */
export function parseRelayControl(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return null; }
}

/**
 * Why a frame an allowed peer sealed for us reached no consumer: sealed for a chat whose key is not
 * held (`no-key`), not opened by that key (`unopenable`), naming another chat than its seal
 * (`wrong-scope`), or of a type or shape this runtime does not read (`unknown`). Never its contents;
 * `type` only when it is a plain payload name.
 */
export type UnreadableFrame = { reason: 'no-key' | 'unopenable' | 'wrong-scope' | 'unknown'; type?: string };
type Unreadable = (frame: UnreadableFrame) => void;

const payloadType = (body: unknown): string | undefined => {
  const type = body && typeof body === 'object' && 'type' in body ? body.type : undefined;
  return typeof type === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(type) ? type : undefined;
};

/** Authenticate routing, peer identity and optional task encryption before consumers run. */
export function openRelayMessage(cfg: PeerConfig, raw: unknown, sessionKeys: Map<string, string>,
  peerAllowed: (key: string) => boolean, unreadable: Unreadable = () => {}) {
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
    unreadable({ reason: 'unknown', type: payloadType(body) });
    return undefined;
  }
  const payload = unwrapTaskPayload(parsedPayload.data, cfg.role, sessionKeys, unreadable);
  if (!payload) return undefined;
  const fingerprint = createHash('sha256').update(env.nonce).update('.').update(env.box).digest('base64url');
  return { env, payload, peerPublicKey: opened.peerPublicKey, fingerprint };
}

function unwrapTaskPayload(payload: Payload, role: string, sessionKeys: Map<string, string>,
  unreadable: Unreadable): Payload | undefined {
  if (payload.type === 'session.key.grant') {
    if (role === 'machine' && !['task', 'project'].includes(payload.purpose ?? '')) return undefined;
    return payload;
  }
  if (payload.type !== 'session.sealed') return payload;
  const key = sessionKeys.get(payload.sessionId);
  if (!key) { unreadable({ reason: 'no-key' }); return undefined; }
  const body = openWithTransferKey(payload.nonce, payload.box, key);
  if (body === null) { unreadable({ reason: 'unopenable' }); return undefined; }
  const inner = Payload.safeParse(body);
  if (!inner.success || inner.data.type === 'session.key.grant' || inner.data.type === 'session.sealed') {
    unreadable({ reason: 'unknown', type: payloadType(body) });
    return undefined;
  }
  const sessionId = 'sessionId' in inner.data ? inner.data.sessionId : undefined;
  if (!payload.sessionId.trim() || typeof sessionId !== 'string' || !sessionId.trim()
    || sessionId !== payload.sessionId) { unreadable({ reason: 'wrong-scope', type: inner.data.type }); return undefined; }
  return inner.data;
}

export { waitForRelayPayload } from "./wait-for";
