import {
  CODEX_TRUST_INSTRUCTION,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
} from "../install";
import { isCursorHttpMcpConfigured } from "../../../mcp/src/cursor-config";
import { installHttpMcpService } from "../../../mcp/src/http-service";

const cursor = installCursorHook();
const claude = installClaudeHook();
const codex = installCodexHook();
const monitor = installMonitorHelper();
const oauth = isCursorHttpMcpConfigured() ? installHttpMcpService() : null;

process.stdout.write(
  [
    `Cursor: ${cursor.status} (${cursor.detail})`,
    `Claude Code: ${claude.status} (${claude.detail})`,
    `Codex: action required — hook ${codex.status} (${codex.detail}). ${CODEX_TRUST_INSTRUCTION}`,
    `Background task sync: ${monitor.status} (${monitor.detail})`,
    oauth
      ? `Persistent Cursor OAuth: ${oauth.status} (${oauth.detail})`
      : "Persistent Cursor OAuth: not configured (run granttap authorize if wanted)",
  ].join("\n") + "\n",
);
