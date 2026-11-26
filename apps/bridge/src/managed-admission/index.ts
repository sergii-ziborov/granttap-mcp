import type { PeerConfig, RelayClientOptions } from "../../../../packages/core/relay-client";
import { loadAccountLink } from "../account-recovery/link";
import { admissionAnswer, failedRequest, recordAccountCheck, type AccountLinkState } from "../account-link-state";

export const SIGN_IN_FIRST = "This computer is not signed in to a GrantTap account, so it cannot use GrantTap's relay. "
  + "Sign it in: granttap sign-in, or Sign in on the GrantTap card.";
export const SIGNED_OUT = "This computer is signed out of your GrantTap account. Sign it in again: granttap sign-in, "
  + "or Sign in again on the GrantTap card.";
const UNVERIFIED = "GrantTap account access could not be verified. Retry when the service is available.";

/** A managed relay refused this computer because of its account sign-in or subscription, not the network. */
export class AccountAdmissionError extends Error {
  constructor(readonly state: Exclude<AccountLinkState, "ok" | "unreachable">, message: string) { super(message); }
}

/** The account service's answer, kept as this computer's account-link state, then turned into a ticket or a reason. */
async function admit(config: PeerConfig, request: typeof fetch): Promise<{ ticket: string; expiresAt: number }> {
  const account = loadAccountLink();
  if (!account) throw new AccountAdmissionError("none", SIGN_IN_FIRST);
  let response: Response;
  try {
    response = await request("https://granttap.com/api/account/machine/admission", {
      method: "POST", headers: { authorization: `Bearer ${account.machineToken}`,
        "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ publicKey: config.myPublicKey, room: config.room }),
      signal: AbortSignal.timeout(8_000), redirect: "error",
    });
  } catch (error) {
    recordAccountCheck("admission", failedRequest(error));
    throw new Error(UNVERIFIED);
  }
  const check = await admissionAnswer(response);
  recordAccountCheck("admission", check);
  if (check.kind === "revoked") throw new AccountAdmissionError("revoked", SIGNED_OUT);
  if (check.kind === "not_covered") {
    throw new AccountAdmissionError(check.state, `This computer is not covered by your GrantTap subscription: ${check.reason}`);
  }
  if (check.kind === "unreachable") throw new Error(UNVERIFIED);
  const body = await response.json() as { ticket?: unknown; expiresAt?: unknown };
  if (typeof body.ticket !== "string" || body.ticket.length > 2_048
    || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)
    || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 360_000) {
    throw new Error("Managed admission returned an invalid lease.");
  }
  return { ticket: body.ticket, expiresAt: body.expiresAt };
}

/** Account computer identity is stable across QR rooms and provider sessions. */
export function managedAdmissionOptions(config: PeerConfig,
  request: typeof fetch = fetch): Pick<RelayClientOptions, "upgradeHeaders" | "connectionLeaseExpiresAt"> {
  if (config.role !== "machine" || !usesManagedRelay(config.relayUrl)) return {};
  let expiresAt: number | null = null;
  return { connectionLeaseExpiresAt: () => expiresAt,
    upgradeHeaders: async (): Promise<Record<string, string>> => {
      const lease = await admit(config, request);
      expiresAt = lease.expiresAt;
      return { "X-GrantTap-Admission": lease.ticket };
    } };
}

/** True when this computer's relay needs a GrantTap account sign-in (GrantTap's managed relay). */
export function usesManagedRelay(relayUrl: string): boolean {
  try {
    const url = new URL(relayUrl);
    return url.protocol === "wss:" && url.hostname === "relay.granttap.com";
  } catch { return false; }
}
