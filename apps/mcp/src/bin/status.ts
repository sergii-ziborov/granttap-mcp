import {
  inspectCursorOAuthReadiness,
  inspectProviderStatusSnapshot,
  inspectWebReadiness,
} from "../provider-status";

const args = process.argv.slice(2);
async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: granttap status [--json]\n");
  } else if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("Usage: granttap status [--json]\n");
    process.exitCode = 1;
  } else {
    const [web, cursorOAuth] = await Promise.all([
      inspectWebReadiness(),
      inspectCursorOAuthReadiness(),
    ]);
    const snapshot = inspectProviderStatusSnapshot(new Date(), web, cursorOAuth);
    if (args[0] === "--json") {
      process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    } else {
      const labels = { cursor: "Cursor", claude: "Claude Code", codex: "Codex", web: "Web" };
      const states = {
        connected: "Connected",
        action_required: "Action required",
        not_configured: "Not configured",
      };
      process.stdout.write([
        "GrantTap status (read-only)",
        ...snapshot.providers.map((provider) =>
          `${labels[provider.id]}: ${states[provider.status]} — ${provider.detail}`),
        "",
      ].join("\n"));
    }
  }
}

void main();
