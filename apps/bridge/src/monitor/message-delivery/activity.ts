import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { UserMessage } from '../../../../../packages/protocol/schema';
import { acknowledgeAgentActivity } from '../../delivery';
import { sendDeliveryReceipt } from '../handlers/receipts';

/** The provider stream confirms activity for one authenticated original operation. */
export function reportMessageAgentActivity(client: RelayClient, message: UserMessage, peerPublicKey?: string): void {
  if (!message.messageId || !message.sessionId || !peerPublicKey) return;
  const at = acknowledgeAgentActivity(message.messageId, Date.now(), {
    room: client.room, sessionId: message.sessionId, peerPublicKey,
  });
  if (at) void sendDeliveryReceipt(client, message.messageId, 'accepted', undefined,
    message.sessionId, peerPublicKey, at);
}
