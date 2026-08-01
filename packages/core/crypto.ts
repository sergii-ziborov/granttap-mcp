/**
 * End-to-end encryption primitives.
 *
 * We use NaCl public-key authenticated encryption (Curve25519 + XSalsa20 +
 * Poly1305) via tweetnacl — the same battle-tested stack the reference
 * open-source client (Happy) uses. Each device holds its own secret key and
 * knows only the peer's PUBLIC key, so the relay (which sees neither secret)
 * can never read message contents.
 *
 * Pairing today = exchange public keys out of band (a generated file; later a
 * QR code scanned by the phone). Nothing here ever leaves the device unsealed.
 */
import nacl from "tweetnacl";

export type KeyPair = { publicKey: string; secretKey: string }; // base64

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const ub64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

/** Seal a JSON-serialisable payload for `theirPublicKey`. */
export function seal(
  payload: unknown,
  theirPublicKey: string,
  mySecretKey: string,
): { nonce: string; box: string } {
  const msg = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(msg, nonce, ub64(theirPublicKey), ub64(mySecretKey));
  return { nonce: b64(nonce), box: b64(box) };
}

/** Open a sealed payload. Returns null on any auth/parse failure. */
export function open(
  nonce: string,
  box: string,
  theirPublicKey: string,
  mySecretKey: string,
): unknown | null {
  let opened: Uint8Array | null = null;
  try {
    opened = nacl.box.open(ub64(box), ub64(nonce), ub64(theirPublicKey), ub64(mySecretKey));
  } catch {
    return null;
  }
  if (!opened) return null;
  try {
    return JSON.parse(new TextDecoder().decode(opened));
  } catch {
    return null;
  }
}

/** Short random hex id (rooms, request ids, device ids). */
export function randomId(bytes = 8): string {
  return Buffer.from(nacl.randomBytes(bytes)).toString("hex");
}

// ------------------------------------------------ secure pairing hand-off v2
//
// The relay-visible mailbox id and the 256-bit transfer key are independent.
// Only the mailbox id is sent to `/pair/<id>`; the key travels inside the QR or
// a manually copied token. A relay operator (or a database dump) therefore has
// the ciphertext but never the key needed to open it.

const b64url = (u: Uint8Array): string => Buffer.from(u).toString("base64url");
const ub64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export function generateTransferKey(): string {
  return b64url(nacl.randomBytes(nacl.secretbox.keyLength));
}

function transferKeyBytes(key: string): Uint8Array | null {
  try {
    const decoded = ub64url(key);
    return decoded.length === nacl.secretbox.keyLength ? decoded : null;
  } catch {
    return null;
  }
}

export function sealWithTransferKey(payload: unknown, key: string): { nonce: string; box: string } {
  const keyBytes = transferKeyBytes(key);
  if (!keyBytes) throw new Error("invalid 256-bit transfer key");
  const msg = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(msg, nonce, keyBytes);
  return { nonce: b64(nonce), box: b64(box) };
}

export function openWithTransferKey(nonce: string, box: string, key: string): unknown | null {
  const keyBytes = transferKeyBytes(key);
  if (!keyBytes) return null;
  let opened: Uint8Array | null = null;
  try {
    opened = nacl.secretbox.open(ub64(box), ub64(nonce), keyBytes);
  } catch {
    return null;
  }
  if (!opened) return null;
  try {
    return JSON.parse(new TextDecoder().decode(opened));
  } catch {
    return null;
  }
}
