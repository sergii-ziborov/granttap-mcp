/**
 * GrantTap MCP server — stdio transport (default for Claude Code / Codex).
 *
 * Cursor Settings → Authorize requires HTTP + OAuth instead:
 *   granttap serve
 * See apps/mcp/src/http-server.ts and docs/cursor-authorize.md.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrantTapServer, relay } from "./create-server";

async function main(): Promise<void> {
  const server = createGrantTapServer();
  await server.connect(new StdioServerTransport());
  // Start task publishing as soon as the MCP process starts. If the machine is
  // not paired yet, the `connect` tool resets and starts it after onboarding.
  void relay();
}

main().catch((err) => {
  process.stderr.write(`[granttap-mcp] ${(err as Error).message}\n`);
  process.exit(1);
});
