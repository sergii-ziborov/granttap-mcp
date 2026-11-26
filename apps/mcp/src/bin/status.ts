import { refreshCodexHooks } from "../../../bridge/src/codex-hook-trust";
import {
  inspectCursorOAuthReadiness,
  inspectProviderStatusSnapshot,
} from "../status/provider-status";
import { inspectMonitorHelper } from "../../../bridge/src/install";
import { isMachineConfigured } from "../status/pairing-status";
import { accountLinkStatus } from "../../../bridge/src/account-link-state";

/** The account line: what fixes it when it is not fine. */
function accountState(): string {
  const status = accountLinkStatus();
  return {
    ok: status.checkedAt === null ? "Signed in (not confirmed yet)" : "Signed in",
    none: "Not signed in — granttap sign-in",
    revoked: "Signed out by GrantTap — granttap sign-in",
    seat_limit: `Not covered: ${status.reason}`,
    no_subscription: `Not covered: ${status.reason}`,
    unreachable: "Signed in; account service not answering",
  }[status.state];
}

const args = process.argv.slice(2);
async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: granttap status [--json]\n");
  } else if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("Usage: granttap status [--json]\n");
    process.exitCode = 1;
  } else {
    await refreshCodexHooks(true);
    const cursorOAuth = await inspectCursorOAuthReadiness();
    const snapshot = inspectProviderStatusSnapshot(new Date(), cursorOAuth);
    if (args[0] === "--json") {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    } else {
      const labels = {
        cursor: "Cursor", claude: "Claude Code", codex: "Codex", grok: "Grok Build",
      };
      const states = {
        connected: "Connected",
        action_required: "Action required",
        not_configured: "Not configured",
      };
      process.stdout.write([
        "GrantTap",
        "",
        `GrantTap account    ${accountState()}`,
        `Phone pairing       ${isMachineConfigured() ? "Ready" : "Not paired"}`,
        `Background helper   ${inspectMonitorHelper().running ? "Running" : "Needs setup"}`,
        "",
        ...snapshot.providers.map((provider) =>
          `${labels[provider.id].padEnd(20)} ${states[provider.status]} — ${provider.detail}`),
        "",
      ].join("\n"));
    }
  }
}

void main();
