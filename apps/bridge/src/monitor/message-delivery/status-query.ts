import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { DeliveryReceiptQuery } from '../../../../../packages/protocol/schema';
import { deliveryReceiptStatus } from '../../delivery';
import { sendDeliveryReceipt } from '../handlers/receipts';

export async function handleDeliveryReceiptQuery(client: RelayClient, query: DeliveryReceiptQuery,
  peerPublicKey?: string): Promise<boolean> {
  if (!peerPublicKey) return true;
  const receipt = deliveryReceiptStatus(query.messageId, { room: client.room, peerPublicKey, sessionId: query.sessionId });
  if (receipt) await sendDeliveryReceipt(client, query.messageId, receipt.status, receipt.error, query.sessionId, peerPublicKey, receipt.agentActivityAt);
  return true;
}
