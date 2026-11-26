import QRCode from "qrcode";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../../../bridge/src/pairing";
import { accountLinkStatus, needsSignIn } from "../../../../bridge/src/account-link-state";
import { isMachineConfigured, phoneSummary } from "../../status/pairing-status";
import type { ConnectionState } from "../../connection-center/state";
import { onAccountSignedIn, startPasskeyAccountLink } from "../../connection-center/passkey";
import { chatStatusLine, type CallingChat } from "../../status/chat-status";
import { accountLine, thisComputerUsesManagedRelay } from "../../status/account-status";
import { resetRelay, relay } from "./relay";

export type ConnectOptions = { issue?: boolean; replace?: boolean; addController?: boolean };

const QR_FAILED = "GrantTap could not create the pairing code. Check the relay and try again. Your existing pairing "
  + "is retained if the relay rejects the request.";
const SIGN_IN_FAILED = "GrantTap could not start the sign-in. Check that granttap.com is reachable and try again.";

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

// A computer signed in again starts this process's relay link with the new sign-in; the monitor's retries by itself.
onAccountSignedIn(() => { if (isMachineConfigured()) { resetRelay(); void relay(); } });

async function issueQr(state: ConnectionState, options: ConnectOptions): Promise<void> {
  const startedAt = Date.now();
  const pairing = await createOneTimePairing(process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY, {
    replace: options.replace === true,
    addController: options.addController === true,
  });
  const png = await QRCode.toBuffer(pairing.qrPayload, { type: "png", width: 900, margin: 4, errorCorrectionLevel: "L" });
  state.remember({
    room: pairing.machineCfg.room,
    expiresAt: startedAt + PAIRING_CODE_TTL_MINUTES * 60_000,
    pairingUri: pairing.qrPayload,
    qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
    peerPublicKey: pairing.phoneCfg.myPublicKey,
  });
  resetRelay();
  void relay();
}

/**
 * Account first. A computer signed in to GrantTap is linked by any phone signed in to the same account, so
 * connect only shows the card and says so. One that is not signed in, or was signed out, gets the passkey
 * sign-in as its first step; an unpaired one also gets the one-time QR on the card as the fallback.
 * `reconnect` (issue) is the QR path for a lost pairing or another device.
 */
export async function connect(state: ConnectionState, options: ConnectOptions = {}): Promise<CallToolResult> {
  if (options.issue || options.replace) {
    try { await issueQr(state, options); return connectionResult(state); } catch { return failure(QR_FAILED); }
  }
  const paired = isMachineConfigured();
  if (paired) void relay();
  const account = accountLinkStatus();
  // A paired computer on its own relay works without an account; on GrantTap's relay it needs one.
  const signIn = account.state === "revoked"
    || (account.state === "none" && (!paired || thisComputerUsesManagedRelay()));
  if (!signIn) return connectionResult(state);
  const passkeyUrl = await startPasskeyAccountLink().catch(() => undefined);
  if (!paired) {
    try { await issueQr(state, {}); } catch { if (!passkeyUrl) return failure(`${SIGN_IN_FAILED} ${QR_FAILED}`); }
  }
  return passkeyUrl ? withPasskeyUrl(connectionResult(state, undefined, passkeyUrl), passkeyUrl) : connectionResult(state);
}

/** `sign_in`: a fresh granttap.com passkey page for this computer, on the card and in the answer. */
export async function signIn(state: ConnectionState): Promise<CallToolResult> {
  try {
    const passkeyUrl = await startPasskeyAccountLink();
    return withPasskeyUrl(connectionResult(state, undefined, passkeyUrl), passkeyUrl);
  } catch {
    return failure(SIGN_IN_FAILED);
  }
}

function withPasskeyUrl(result: CallToolResult, passkeyUrl: string): CallToolResult {
  const meta = result._meta?.granttap;
  const granttap = meta && typeof meta === "object" ? meta : {};
  return { ...result, structuredContent: { ...result.structuredContent, passkeyUrl },
    _meta: { ...result._meta, granttap: { ...granttap, passkeyUrl } } };
}

const SIGN_IN_STEP = (url: string) => `Sign this computer in to GrantTap: give the person ${url} (one use, valid 15 `
  + "minutes; also on the GrantTap card). They confirm with their GrantTap passkey, entered only on that page. ";
const PHONE_LINKS = "Open GrantTap on the iPhone signed in to the same account: it links this computer by itself.";

function instructions(status: string, signedIn: boolean, passkeyUrl: string | undefined): string {
  if (passkeyUrl) {
    return SIGN_IN_STEP(passkeyUrl) + `Then: ${PHONE_LINKS}`
      + (status === "pairing" ? " If that phone is not signed in to the account, scan the one-time QR on the card instead." : "");
  }
  if (status === "pairing") return "Use the GrantTap card: scan the QR on the card with GrantTap on the phone.";
  if (status === "expired") return "The card QR expired. Tap Create a new QR on the card and confirm.";
  if (status === "disconnected") {
    return signedIn ? `${PHONE_LINKS} A QR is only needed if it does not: reconnect, after the person confirms, shows one on the card.`
      : "Call connect: it signs this computer in to GrantTap, with a one-time QR on the card as the fallback.";
  }
  return "The GrantTap card shows the saved pairing room on this computer and last confirmed activity. Add another phone "
    + "to start a new enrollment attempt. A Mesh link shares Mesh only.";
}

export function connectionResult(state: ConnectionState, caller?: CallingChat, passkeyUrl?: string): CallToolResult {
  const snapshot = caller ? state.snapshot(Date.now(), caller) : state.snapshot();
  const { status, computer, relay, version, relayStatus, runtimeUpdates, phones, pendingUpdate, chat, accountLink } =
    snapshot.structuredContent;
  const details = [
    accountLine(accountLink, thisComputerUsesManagedRelay()),
    phoneSummary(phones),
    pendingUpdate ? `Runtime ${pendingUpdate.version} is waiting: ${pendingUpdate.detail}` : undefined,
    chatStatusLine(chat),
  ].filter(Boolean).join("\n");
  return {
    ...snapshot,
    content: [{ type: "text", text: `GrantTap: ${status}. Computer: ${computer}. MCP ${version}. Relay: `
      + `${relay || "not configured"} (${relayStatus}). Automatic runtime updates: ${runtimeUpdates.enabled ? "on" : "off"}.\n`
      + `${details ? `${details}\n` : ""}${instructions(status, !needsSignIn(accountLink), passkeyUrl)}` }],
  };
}
