import { startHttpMcpServer } from "../http-server";

async function serve(): Promise<void> {
  const started = await startHttpMcpServer();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void started.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
    process.stderr.write(
      [
        `[granttap-mcp] HTTP MCP + OAuth listening on ${started.mcpUrl}`,
        "[granttap-mcp] Cursor authentication: set ~/.cursor/mcp.json entry to:",
        `  "granttap": { "url": "${started.mcpUrl}" }`,
        "[granttap-mcp] Then open Cursor Customize → MCPs → GrantTap → Authenticate and continue at granttap.com/connect.",
        "",
      ].join("\n"),
    );
}

void serve().catch((error: unknown) => {
    process.stderr.write(
      `[granttap-mcp] serve failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
