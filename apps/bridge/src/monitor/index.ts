import type { RelayClient } from "../../../../packages/core/relay-client";
import { startSessionMonitor as start } from "./support/runtime";

export { HISTORY_PUBLISH_LIMIT, boundedCatalogHistory, publishSessionEvents } from "./handlers/catalog";
export { sendDeliveryReceipt, agentEventForUserMessage } from "./handlers/receipts";
export {
  RESUME_PROMPT,
  handleConfigSet,
  handleHostGrant,
  handleSessionControl,
  handleSubscription,
  handleSubscription as handleSubscriptionForTest,
} from "./handlers/session-commands";
export { handleTaskCreate } from "./handlers/task-create";
export { sweepAttachments, resolveMessageAttachments } from "./handlers/receipts";
export { handleUserMessage } from "./handlers/user-message";
export type { SessionMonitor } from "./support/runtime";

export function startSessionMonitor(client: RelayClient) {
  return start(client);
}
