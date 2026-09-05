/**
 * GrantTap MCP server — stdio transport (default for Claude Code / Codex).
 *
 * Cursor Settings → Authorize requires HTTP + OAuth instead:
 *   granttap internal serve
 * See apps/mcp/src/http-server.ts and docs/cursor-authorize.md.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGrantTapServer, relay } from "./create-server";

/**
 * Leave when the agent that started this server is gone.
 *
 * An MCP server whose stdin closed has no one left to talk to, yet it used to
 * live on for weeks — nine of them at once, each holding a relay connection
 * and publishing with the code of the day it started. The pipe closing is
 * the only word the agent leaves; act on it.
 */
export function exitWhenAgentLeaves(
  input: NodeJS.ReadableStream = process.stdin,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    exit(0);
  };
  input.once("end", leave);
  input.once("close", leave);
}

async function main(): Promise<void> {
  const server = createGrantTapServer();
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  exitWhenAgentLeaves();
  await server.connect(transport);
  // Start task publishing as soon as the MCP process starts. If the machine is
  // not paired yet, the `connect` tool resets and starts it after onboarding.
  void relay();
}

if (process.env.GRANTTAP_MCP_NO_MAIN !== "1") main().catch((err) => {
  process.stderr.write(`[granttap-mcp] ${(err as Error).message}\n`);
  process.exit(1);
});
