import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODEX_TRUST_INSTRUCTION, installClaudeHook, installCodexHook, installCursorHook, installMonitorHelper } from "../../../bridge/src/install";
import { isCursorHttpMcpConfigured } from "../cursor-config";
import { installHttpMcpService } from "../http-service";
import { isMachineConfigured } from "../pairing-status";

export function registerSetupTool(server: McpServer): void {
  server.tool(
    "setup",
    "Register GrantTap Cursor, Claude Code, and Codex policy hooks plus terminal-free background task sync on this machine. OAuth remains a separate granttap authorize step.",
    {},
    async () => ({ content: [{ type: "text", text: setupText() }] }),
  );
}

function setupText(): string {
  const cursor = installCursorHook();
  const claude = installClaudeHook();
  const codex = installCodexHook();
  const monitor = installMonitorHelper();
  const oauth = isCursorHttpMcpConfigured() ? installHttpMcpService() : null;
  return [
    `Cursor: ${cursor.status} (${cursor.detail})`,
    `Claude: ${claude.status} (${claude.detail})`,
    `Codex: action required — hook ${codex.status} (${codex.detail}). ${CODEX_TRUST_INSTRUCTION}`,
    `Background task sync: ${monitor.status} (${monitor.detail})`,
    oauth ? `Persistent Cursor OAuth: ${oauth.status} (${oauth.detail})` : "Persistent Cursor OAuth: not configured (run granttap authorize if wanted)",
    "",
    "Cursor shell/MCP policy hooks are installed above. Settings → Authorize (OAuth) is separate:",
    "  granttap authorize",
    "Then set ~/.cursor/mcp.json granttap to:",
    '  { "url": "http://127.0.0.1:17342/mcp" }',
    isMachineConfigured() ? "This machine already has local pairing keys; Authorize will confirm linking Cursor." : "This machine is not paired yet; Authorize will offer a pairing QR first.",
  ].join("\n");
}
