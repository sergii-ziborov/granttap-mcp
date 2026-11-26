import { spawn } from "node:child_process";
import { accountLinkStatus, linkFingerprint, verifyAccountLink } from "../../../bridge/src/account-link-state";
import { activeAccountPoller } from "../../../bridge/src/account-recovery/lease";
import { loadAccountLink } from "../../../bridge/src/account-recovery/link";
import { onAccountSignedIn, startPasskeyAccountLink } from "../connection-center/passkey";
import { runSignIn, SIGN_IN_USAGE } from "./sign-in-command";
import { websiteOrigin } from "../oauth/consent/website-session";
import { isMachineConfigured } from "../status/pairing-status";

/** The page opens in the browser on this computer only from a terminal a person is at. */
function openInBrowser(url: string): void {
  if (process.platform !== "darwin" || !process.stdout.isTTY) return;
  try { spawn("open", [url], { stdio: "ignore", detached: true }).unref(); } catch { /* the printed page still works */ }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(SIGN_IN_USAGE);
} else if (args.some(arg => arg !== "--no-open")) {
  process.stderr.write(SIGN_IN_USAGE);
  process.exitCode = 1;
} else {
  void runSignIn({
    start: startPasskeyAccountLink,
    signedIn: onAccountSignedIn,
    verify: async () => {
      const origin = websiteOrigin();
      return origin ? verifyAccountLink(origin) : accountLinkStatus();
    },
    linkFingerprint: () => { const link = loadAccountLink(); return link ? linkFingerprint(link) : null; },
    paired: isMachineConfigured,
    answering: () => activeAccountPoller()?.role ?? null,
    open: args.includes("--no-open") ? undefined : openInBrowser,
    write: text => { process.stdout.write(text); },
  }).then(code => process.exit(code));
}
