import {
  inspectCursorOAuthReadiness,
  inspectProviderStatusSnapshot,
} from "../provider-status";
import { inspectMonitorHelper } from "../../../bridge/src/install";
import { isMachineConfigured } from "../pairing-status";

const args = process.argv.slice(2);
async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: granttap status [--json]\n");
  } else if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("Usage: granttap status [--json]\n");
    process.exitCode = 1;
  } else {
    const cursorOAuth = await inspectCursorOAuthReadiness();
    const snapshot = inspectProviderStatusSnapshot(new Date(), cursorOAuth);
    if (args[0] === "--json") {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    } else {
      const labels = { cursor: "Cursor", claude: "Claude Code", codex: "Codex" };
      const states = {
        connected: "Connected",
        action_required: "Action required",
        not_configured: "Not configured",
      };
      process.stdout.write([
        "GrantTap",
        "",
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
