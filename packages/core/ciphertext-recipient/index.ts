import { createHash } from 'node:crypto';

/** Only a routing hint. Ciphertext authentication remains the authorization boundary. */
export function publicKeyIdentifier(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
}
