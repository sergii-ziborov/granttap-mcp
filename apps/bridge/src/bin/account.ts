import QRCode from "qrcode";
import { completeLogin, startLogin } from "../account-linking/client";
import { protectedVault } from "../account-linking/keychain";
import { AccountStore } from "../account-linking/store";
import { configDir } from "../config";

const [command = "status", ...args] = process.argv.slice(2);
const store = new AccountStore(configDir(), protectedVault());
const option = (name: string): string | undefined => {
  const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];
};

function status(): string {
  const value = store.status();
  if (value.kind === "signed_out") return "GrantTap account: signed out (Personal/Team login is optional).";
  if (value.kind === "pending") return "GrantTap account: waiting for one-time QR confirmation.";
  const org = value.account.organizationId ? ` · organization ${value.account.organizationId}` : "";
  return `GrantTap account: ${value.kind === "expired" ? "expired" : "signed in"} · ${value.account.mode}${org} · device ${value.account.deviceId}`;
}

async function main(): Promise<void> {
  if (command === "status") { process.stdout.write(`${status()}\n`); return; }
  if (command === "logout") {
    store.logout();
    process.stdout.write("GrantTap account: signed out. Phone pairing and provider logins were not changed.\n");
    return;
  }
  if (args.includes("--complete")) {
    const result = await completeLogin(store);
    process.stdout.write(result === "authorized" ? `${status()}\n` : "GrantTap login is still pending.\n");
    return;
  }
  const organization = option("--organization");
  const mode = args.includes("--enterprise") || organization ? "enterprise" : "personal";
  if (command === "login" && store.status().kind === "signed_in") {
    process.stdout.write(`${status()}\nUse granttap relogin to authenticate again.\n`); return;
  }
  const authorization = await startLogin(store, {
    controlUrl: option("--control") ?? process.env.GRANTTAP_CONTROL_URL ?? "https://control.granttap.com",
    mode, ...(organization ? { organization } : {}),
  });
  const qr = await QRCode.toString(authorization.verificationUriComplete, {
    type: "terminal", small: true, errorCorrectionLevel: "M",
  });
  process.stdout.write(["", `GrantTap ${mode} login`, "", qr, "",
    `Open: ${authorization.verificationUri}`, `One-time code: ${authorization.userCode}`,
    "The QR contains no device code, token, pairing key, or provider credential.",
    "After approval: granttap login --complete", ""].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[granttap] ${command} failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
