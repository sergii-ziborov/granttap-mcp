/**
 * A new task this computer refuses before its provider starts.
 *
 * Up to 0.8.207 such a refusal was one short-lived message without a chat: the phone kept the new
 * task's chat open on the person's words with nothing under them, the monitor log said nothing, and
 * a follow-up written into that chat waited on the relay for a chat that would never exist. Now the
 * person's message gets a rejection receipt carrying the reason, the creation is recorded as refused
 * so its follow-ups fail at once, and the monitor log names the reason (never the person's words).
 */
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { UserMessage } from "../../../../../packages/protocol/schema";
import type { TaskOriginRegistry, TaskOriginScope } from "../../task-origins";
import { sendDeliveryReceipt } from "../handlers/receipts";

export async function refuseNewTask(input: {
  client: RelayClient;
  message: UserMessage;
  displayName: string;
  reason: string;
  say: (text: string, sessionId?: string, wake?: boolean) => Promise<unknown>;
  origin?: { registry: TaskOriginRegistry; scope: TaskOriginScope };
  peerPublicKey?: string;
}): Promise<"rejected"> {
  const { client, message, reason } = input;
  process.stderr.write(`[monitor] A new ${input.displayName} task from the phone was refused: ${reason.slice(0, 200)}\n`);
  try { input.origin?.registry.refuse(input.origin.scope, message); }
  catch { /* The receipt below still tells the phone. */ }
  await input.say(reason, undefined, true);
  if (message.messageId) {
    await sendDeliveryReceipt(client, message.messageId, "rejected", reason, undefined, input.peerPublicKey);
  }
  return "rejected";
}
