import type { Payload } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { abandonDelivery, beginDelivery, completeDelivery,
  acknowledgeProcessingDelivery, processingDeliveryAcknowledged, completedDeliveryFailure, deliveryReceiptStatus } from "../../delivery";
import { sendDeliveryReceipt } from "../handlers/receipts";
import { handleUserMessage } from "../handlers/user-message";

/** Receipts acknowledge durable receipt, while the correlated response is terminal. */
export async function handleInboundUserMessage(
  client: RelayClient, payload: Extract<Payload, { type: "user.message" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
  peerPublicKey?: string,
  native?: { messageId: string; nativeOnly: true },
): Promise<boolean> {
  if (payload.requestId) return false;
  let deliveryStarted = false;
  if (payload.messageId) {
    const state = beginDelivery(payload.messageId, Date.now(), payload.sessionId && peerPublicKey
      ? { room: client.room, sessionId: payload.sessionId, peerPublicKey } : undefined);
    if (state !== "started") {
      if (state === "completed" || processingDeliveryAcknowledged(payload.messageId)) {
        const failure = completedDeliveryFailure(payload.messageId);
        await sendDeliveryReceipt(client, payload.messageId, failure ? 'rejected' : 'accepted',
          failure, payload.sessionId, peerPublicKey, peerPublicKey && payload.sessionId
            ? deliveryReceiptStatus(payload.messageId, { room: client.room, peerPublicKey,
              sessionId: payload.sessionId })?.agentActivityAt : undefined);
      }
      return true;
    }
    deliveryStarted = true;
  }
  try {
    const outcome = await handleUserMessage(client, payload, async () => {
      if (!payload.messageId) return;
      acknowledgeProcessingDelivery(payload.messageId);
      await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId, peerPublicKey);
    }, peerPublicKey, native);
    if (payload.messageId && deliveryStarted) {
      if (outcome === "rejected") abandonDelivery(payload.messageId);
      else {
        completeDelivery(payload.messageId);
        await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId, peerPublicKey);
      }
    }
    void publish().catch(() => {});
    return true;
  } catch {
    if (payload.messageId && deliveryStarted) abandonDelivery(payload.messageId);
    return false;
  }
}
