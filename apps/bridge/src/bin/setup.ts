import { installClaudeHook, installCodexHook } from "../install";

const claude = installClaudeHook();
const codex = installCodexHook();

process.stdout.write(
  [
    `Claude Code: ${claude.status} (${claude.detail})`,
    `Codex: ${codex.status} (${codex.detail})`,
  ].join("\n") + "\n",
);
