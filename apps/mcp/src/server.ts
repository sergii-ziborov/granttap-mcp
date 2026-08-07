/**
 * GrantTap MCP server — stdio front door for agents that spawn a local process.
 *
 * Cursor Authorize needs the HTTP listener (`granttap-mcp serve`); stdio alone
 * never shows the Authorize button in Plugins.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrantTapServer, startGrantTapBackground } from "./create-server";

async function main(): Promise<void> {
  const server = createGrantTapServer();
  await server.connect(new StdioServerTransport());
  // Start task publishing as soon as the MCP process starts. If the machine is
  // not paired yet, the `connect` tool resets and starts it after onboarding.
  startGrantTapBackground();
}

main().catch((err) => {
  process.stderr.write(`[granttap-mcp] ${(err as Error).message}\n`);
  process.exit(1);
});
