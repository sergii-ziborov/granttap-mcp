import { accountServiceOrigin } from "../../../../bridge/src/account-link-state";
import { startAccountRecoveryPoller } from "../../../../bridge/src/account-recovery/poller";
import { reloadMonitorHelper } from "../../../../bridge/src/install";
import { relay, resetRelay } from "./relay";

/** A phone admitted through the account reaches the monitor (restarted to read the pairing) and this process's link. */
function refreshRecoveredPairing(): void {
  reloadMonitorHelper();
  resetRelay();
  void relay();
}

/**
 * The MCP service and every chat's stdio MCP server ask for the computer's one account-poller lease next to
 * the monitor, so a computer whose monitor is not running yet (no pairing so far) still answers a phone
 * signing in with the account. Only the lease holder polls.
 */
export function startComputerAccountRecovery(role: "service" | "chat"): () => void {
  const origin = accountServiceOrigin();
  return origin ? startAccountRecoveryPoller(origin, refreshRecoveredPairing, { role }) : () => {};
}
