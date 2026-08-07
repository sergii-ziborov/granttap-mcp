import {
  installClaudeHook,
  installCodexHook,
  installCursorMcpHttpConfig,
  installCursorPluginLocal,
  installHttpServeHelper,
  installMonitorHelper,
} from "../install";

const claude = installClaudeHook();
const codex = installCodexHook();
const monitor = installMonitorHelper();
const httpServe = installHttpServeHelper();
const cursorMcp = installCursorMcpHttpConfig();
const cursorPlugin = installCursorPluginLocal();

process.stdout.write(
  [
    `Claude Code: ${claude.status} (${claude.detail})`,
    `Codex: ${codex.status} (${codex.detail})`,
    `Background task sync: ${monitor.status} (${monitor.detail})`,
    `HTTP MCP serve (Authorize): ${httpServe.status} (${httpServe.detail})`,
    `Cursor MCP HTTP config: ${cursorMcp.status} (${cursorMcp.detail})`,
    `Cursor local plugin: ${cursorPlugin.status} (${cursorPlugin.detail})`,
  ].join("\n") + "\n",
);
