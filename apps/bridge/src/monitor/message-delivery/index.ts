import type { Payload } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { abandonDelivery, beginDelivery, completeDelivery,
  acknowledgeProcessingDelivery, processingDeliveryAcknowledged } from "../../delivery";
import { sendDeliveryReceipt } from "../handlers/receipts";
import { handleUserMessage } from "../handlers/user-message";

/** Receipts acknowledge durable receipt, while the correlated response is terminal. */
export async function handleInboundUserMessage(
  client: RelayClient, payload: Extract<Payload, { type: "user.message" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): Promise<boolean> {
  if (payload.requestId) return false;
  let deliveryStarted = false;
  if (payload.messageId) {
    const state = beginDelivery(payload.messageId);
    if (state !== "started") {
      if (state === "completed" || processingDeliveryAcknowledged(payload.messageId)) {
        await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
      }
      return true;
    }
    deliveryStarted = true;
  }
  try {
    const outcome = await handleUserMessage(client, payload, async () => {
      if (!payload.messageId) return;
      acknowledgeProcessingDelivery(payload.messageId);
      await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
    });
    if (payload.messageId && deliveryStarted) {
      if (outcome === "rejected") abandonDelivery(payload.messageId);
      else {
        completeDelivery(payload.messageId);
        await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
      }
    }
    void publish().catch(() => {});
    return true;
  } catch {
    if (payload.messageId && deliveryStarted) abandonDelivery(payload.messageId);
    return false;
  }
}
