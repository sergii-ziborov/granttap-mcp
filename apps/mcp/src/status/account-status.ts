import { z } from "zod";
import {
  ACCOUNT_LINK_STATES, accountLinkStatus, needsSignIn, notCovered, type AccountLinkStatus,
} from "../../../bridge/src/account-link-state";
import { activeAccountPoller } from "../../../bridge/src/account-recovery/lease";
import { DEFAULT_RELAY_URL, loadConfig } from "../../../bridge/src/config";
import { applyNetworkRoute, readNetworkSettings } from "../../../bridge/src/device-network/settings";
import { usesManagedRelay } from "../../../bridge/src/managed-admission";
import { isMachineConfigured, readOnlyMachineConfigPath } from "./pairing-status";

export const accountLinkOutput = z.object({
  state: z.enum(ACCOUNT_LINK_STATES).describe("none: never signed in; ok: GrantTap accepts the sign-in (checkedAt null: "
    + "saved, not confirmed yet); revoked: GrantTap no longer accepts it, call sign_in; seat_limit or no_subscription: "
    + "signed in, but the subscription does not cover this computer, so GrantTap's relay refuses it; unreachable: the "
    + "account service has not answered for about 30 seconds"),
  reason: z.string().describe("One sentence for a person, the account service's own when it gave one"),
  checkedAt: z.number().nullable().describe("When the account service last answered for this computer's sign-in; null: not yet"),
  answeredBy: z.enum(["monitor", "service", "chat"]).nullable().describe("Which GrantTap process on this computer answers "
    + "phones signing in with the account: the background helper, the MCP service, or a chat's MCP server; null: none "
    + "runs, so a phone cannot link this computer by itself"),
}).describe("This computer's sign-in to the person's GrantTap account. While it is ok, a phone signed in to the same "
  + "account links this computer by itself, without a QR");

export type AccountLinkSnapshot = AccountLinkStatus & { answeredBy: "monitor" | "service" | "chat" | null };

/** `accountLink` for status views, and the compatible `accountLinkSaved` (true only while the sign-in is ok). */
export function accountLinkSnapshot(now = Date.now()): { accountLinkSaved: boolean; accountLink: AccountLinkSnapshot } {
  const status = accountLinkStatus();
  return { accountLinkSaved: status.state === "ok",
    accountLink: { ...status, answeredBy: activeAccountPoller(now)?.role ?? null } };
}

export const SIGN_IN_HOW = "call sign_in (or run `granttap sign-in` in Terminal, or tap Sign in again on the GrantTap card)";
export const MANAGED_COMPUTERS = "https://granttap.com/account#managed-computers";

/** What the subscription needs, in the words the card and the tools share. */
export function coverageHelp(status: AccountLinkStatus): string {
  return status.state === "seat_limit"
    ? `Every computer place on the plan is in use: turn another computer off under Managed computers (${MANAGED_COMPUTERS}) `
      + "or choose a larger plan in GrantTap → Subscription."
    : `Subscribe in GrantTap → Subscription on the iPhone, or turn this computer on under Managed computers (${MANAGED_COMPUTERS}).`;
}

/**
 * The sentence a tool says when this computer's account is why nothing reaches the phone, or null when the
 * account is fine. `none` is a problem only on GrantTap's relay, which admits signed-in computers only.
 */
export function accountProblem(status: AccountLinkStatus, managedRelay: boolean): string | null {
  if (status.state === "revoked") {
    return `This computer is signed out of your GrantTap account (${status.reason.replace(/\.$/, "")}). Sign it in: ${SIGN_IN_HOW}.`;
  }
  if (status.state === "none" && managedRelay) {
    return `This computer is not signed in to a GrantTap account, so it cannot use GrantTap's relay. Sign it in: ${SIGN_IN_HOW}.`;
  }
  if (notCovered(status)) {
    return `This computer is signed in, but not covered by your GrantTap subscription (${status.reason.replace(/\.$/, "")}). `
      + coverageHelp(status);
  }
  return null;
}

/** One line for a tool's text: what the account says about this computer. */
export function accountLine(status: AccountLinkSnapshot, managedRelay: boolean): string {
  const problem = accountProblem(status, managedRelay);
  if (problem) return `Account: ${problem}`;
  if (needsSignIn(status)) return "Account: not signed in. Signing in (sign_in) lets a phone signed in to the same "
    + "account link this computer without a QR.";
  if (status.state === "unreachable") return `Account: signed in, but GrantTap's account service has not answered: ${status.reason}`;
  return `Account: signed in${status.checkedAt === null ? " (not confirmed yet)" : ""}; a phone signed in to the same `
    + "account links this computer by itself.";
}

/** True when this computer's relay is GrantTap's, which admits only a computer signed in to a GrantTap account. */
export function thisComputerUsesManagedRelay(): boolean {
  try {
    if (isMachineConfigured()) {
      return usesManagedRelay(applyNetworkRoute(loadConfig(readOnlyMachineConfigPath())).relayUrl);
    }
    return readNetworkSettings().mode === "managed" && usesManagedRelay(process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY_URL);
  } catch { return true; }
}
