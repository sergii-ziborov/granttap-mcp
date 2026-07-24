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
import { createHash } from "node:crypto";

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

// ------------------------------------------------- short pairing code (typed)
//
// A QR needs a camera; the simulator (and a tired thumb) needs something you can
// type. The machine seals the pairing under a key derived from an 8-character
// code and parks that ciphertext on the relay. The relay still learns nothing —
// it only ever holds a blob it cannot open — and the code is single-use with a
// short TTL, which is what keeps 8 characters from being brute-forceable.

/** Unambiguous alphabet: no 0/O/1/I/L to avoid transcription mistakes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePairingCode(length = 8): string {
  const bytes = nacl.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Key = SHA-256(normalized code). Mirrored byte-for-byte on the Swift side. */
function codeKey(code: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(normalizeCode(code), "utf8").digest());
}

export function sealWithCode(payload: unknown, code: string): { nonce: string; box: string } {
  const msg = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(msg, nonce, codeKey(code));
  return { nonce: b64(nonce), box: b64(box) };
}

export function openWithCode(nonce: string, box: string, code: string): unknown | null {
  let opened: Uint8Array | null = null;
  try {
    opened = nacl.secretbox.open(ub64(box), ub64(nonce), codeKey(code));
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
