import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import nacl from 'tweetnacl';

/** Bounded, process-local NaCl precomputation; raw private keys never become cache identities. */
export function createSharedBoxCache(options: {
  capacity?: number; ttlMs?: number; now?: () => number;
  derive?: (publicKey: Uint8Array, secretKey: Uint8Array) => Uint8Array;
} = {}) {
  const capacity = Number.isSafeInteger(options.capacity) && options.capacity! > 0 ? Math.min(256, options.capacity!) : 64;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs! > 0 ? options.ttlMs! : 60_000;
  const now = options.now ?? (() => performance.now()), derive = options.derive ?? nacl.box.before;
  const entries = new Map<string, {key: Uint8Array; expiresAt: number}>();
  return {
    get(publicKey: string, secretKey: string): Uint8Array {
      const pub = Buffer.from(publicKey, 'base64'), secret = Buffer.from(secretKey, 'base64');
      try {
        if (pub.length !== nacl.box.publicKeyLength) throw Error('bad public key size');
        if (secret.length !== nacl.box.secretKeyLength) throw Error('bad secret key size');
        const identity = createHash('sha256').update(pub).update(secret).digest('hex'), at = now();
        const hit = entries.get(identity);
        if (hit && hit.expiresAt > at) {entries.delete(identity); entries.set(identity, hit); return hit.key}
        for (const [id, entry] of entries) if (entry.expiresAt <= at) {entry.key.fill(0); entries.delete(id)}
        const key = derive(pub, secret);
        entries.set(identity, {key, expiresAt: at + ttlMs});
        while (entries.size > capacity) {
          const id = entries.keys().next().value!;
          entries.get(id)!.key.fill(0); entries.delete(id);
        }
        return key;
      } finally {secret.fill(0)}
    },
    clear() {for (const entry of entries.values()) entry.key.fill(0); entries.clear()},
  };
}

const sharedBoxes = createSharedBoxCache();
export const sharedBoxKey = (publicKey: string, secretKey: string) => sharedBoxes.get(publicKey, secretKey);
export const clearSharedBoxKeys = () => sharedBoxes.clear();
