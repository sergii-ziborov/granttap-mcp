import type { AccountLinkStatus } from "../../../bridge/src/account-link-state";

export const SIGN_IN_USAGE = [
  "Usage: granttap sign-in [--no-open]",
  "",
  "Signs this computer in to your GrantTap account with your passkey: prints a one-time granttap.com page,",
  "opens it in the browser on macOS (unless --no-open), and waits until you confirm there. Then a phone",
  "signed in to the same account links this computer by itself, without a QR. Existing pairings stay.",
  "",
].join("\n");

export type SignInDeps = {
  /** The granttap.com passkey page for this computer (`startPasskeyAccountLink`). */
  start: () => Promise<string>;
  /** Told once the page saved this computer's sign-in. */
  signedIn: (listener: () => void) => () => void;
  /** The sign-in as the account service answers for it now. */
  verify: () => Promise<AccountLinkStatus>;
  /** A fingerprint of the saved sign-in, to notice one that finished while the page could not say so. */
  linkFingerprint: () => string | null;
  paired: () => boolean;
  /** Which GrantTap process answers phones now; null when none runs. */
  answering: () => string | null;
  open?: (url: string) => void;
  write: (text: string) => void;
  timeoutMs?: number;
};

function waitForSignIn(deps: SignInDeps, before: string | null): Promise<boolean> {
  return new Promise(resolve => {
    let off = () => {};
    const finish = (done: boolean) => { clearTimeout(timer); off(); resolve(done); };
    // Kept referenced: this wait is what keeps the command alive while the person is on the page.
    const timer = setTimeout(() => finish(deps.linkFingerprint() !== before), deps.timeoutMs ?? 15 * 60_000);
    off = deps.signedIn(() => finish(true));
  });
}

function outcome(status: AccountLinkStatus, deps: SignInDeps): string[] {
  if (status.state === "revoked" || status.state === "none") {
    return [`GrantTap did not accept the sign-in: ${status.reason}`, "Run granttap sign-in again."];
  }
  const lines = [status.state === "unreachable"
    ? "Signed in. GrantTap could not confirm it just now; it is checked again in the background."
    : "Signed in to GrantTap."];
  if (status.state === "seat_limit" || status.state === "no_subscription") {
    lines.push(`This computer is not covered by your subscription yet: ${status.reason}`);
  }
  lines.push(deps.paired()
    ? "Phones signed in to the same account reach this computer again; nothing else to do."
    : "Open GrantTap on your iPhone signed in to the same account: it links this computer by itself, no QR needed.");
  if (!deps.answering()) {
    lines.push("No GrantTap helper is running on this computer to answer the phone: run granttap setup first.");
  }
  return lines;
}

/** `granttap sign-in`: 0 when this computer ends up signed in, 1 when it does not. */
export async function runSignIn(deps: SignInDeps): Promise<number> {
  const before = deps.linkFingerprint();
  let url: string;
  try { url = await deps.start(); } catch {
    deps.write("GrantTap could not start the sign-in: granttap.com did not accept it. Check the connection and try again.\n");
    return 1;
  }
  deps.write(["Sign this computer in to GrantTap:", "", `  ${url}`, "",
    "Open it and confirm with your GrantTap passkey; the page works once, for 15 minutes. Waiting…", ""].join("\n"));
  deps.open?.(url);
  if (!await waitForSignIn(deps, before)) {
    deps.write("The page expired before the sign-in was confirmed. Run granttap sign-in again.\n");
    return 1;
  }
  const status = await deps.verify();
  deps.write(`${outcome(status, deps).join("\n")}\n`);
  return status.state === "revoked" || status.state === "none" ? 1 : 0;
}
