import { installClaudeHook, installCodexHook, installMonitorHelper } from "../install";

const claude = installClaudeHook();
const codex = installCodexHook();
const monitor = installMonitorHelper();

process.stdout.write(
  [
    `Claude Code: ${claude.status} (${claude.detail})`,
    `Codex: ${codex.status} (${codex.detail})`,
    `Background task sync: ${monitor.status} (${monitor.detail})`,
  ].join("\n") + "\n",
);
