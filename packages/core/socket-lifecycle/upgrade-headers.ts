import type { PeerConfig } from '../relay-client-types';
import { publicKeyIdentifier } from '../ciphertext-recipient';

/** Bind optional mailbox routing to this endpoint's real encryption identity. */
export function relayUpgradeHeaders(cfg: PeerConfig, admission: Record<string, string>, durableReceiver: boolean) {
  return { ...admission, 'X-GrantTap-Recipient-Routing': '1',
    ...((cfg.role === 'phone' || durableReceiver)
      ? { 'X-GrantTap-Recipient-Key-Id': publicKeyIdentifier(cfg.myPublicKey) } : {}),
    ...(durableReceiver ? { 'X-GrantTap-Task-Dispatch': '1' } : {}),
    ...(cfg.pushAuth ? { Authorization: `Bearer ${cfg.pushAuth}` } : {}) };
}
