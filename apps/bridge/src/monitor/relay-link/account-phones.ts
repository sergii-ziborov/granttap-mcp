import type { RelayClient } from "../../../../../packages/core/relay-client";
import { accountLinkStatus, accountServiceOrigin, needsSignIn, notCovered } from "../../account-link-state";
import { startAccountRecoveryPoller } from "../../account-recovery/poller";
import { loadConfig, machineConfigPath } from "../../config";
import { reloadMonitorHelper } from "../../install";

type Link = Pick<RelayClient, "room" | "addControllerPeer">;

/**
 * A phone the account sign-in admitted joins this monitor's relay link at once: its key is already in the
 * pairing on disk, so it is added to the running client and the catalog goes out to it, with no restart. A
 * pairing created for another room (none existed when the phone asked) needs a fresh monitor.
 */
export function adoptAdmittedPhones(client: Link, publish: () => Promise<void>,
  restart: () => void = () => { reloadMonitorHelper(); }): void {
  try {
    const live = loadConfig(machineConfigPath());
    if (live.role !== "machine" || live.room !== client.room) {
      process.stderr.write("[monitor] an account sign-in created a new pairing; restarting to use it\n");
      restart();
      return;
    }
    for (const key of [live.peerPublicKey, ...(live.extraPeerPublicKeys ?? [])]) {
      try { client.addControllerPeer(key); } catch { /* not allowed (expired, removed) or the sixteen places are full */ }
    }
    void publish().catch(() => {});
  } catch { /* the pairing could not be read; the next admitted phone tries again */ }
}

/** The monitor is one of the processes that may answer phones signing in with the account (`account-recovery`). */
export function startMonitorAccountRecovery(client: Link, publish: () => Promise<void>): () => void {
  const origin = accountServiceOrigin();
  return origin ? startAccountRecoveryPoller(origin, () => adoptAdmittedPhones(client, publish), { role: "monitor" }) : () => {};
}

/**
 * Why the relay keeps refusing this computer, when the reason is its GrantTap account and not the link: a
 * fresh monitor cannot cure that, so the link-restart is skipped and the log says what does.
 */
export function accountRefusalHint(): string | null {
  const status = accountLinkStatus();
  if (needsSignIn(status)) {
    return status.state === "none"
      ? "this computer is not signed in to a GrantTap account; run granttap sign-in"
      : "this computer is signed out of its GrantTap account; run granttap sign-in";
  }
  if (notCovered(status)) return `this computer is not covered by the GrantTap subscription (${status.reason})`;
  return null;
}
