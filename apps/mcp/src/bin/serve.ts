import { startHttpMcpServer } from "../http/http-server";

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
        `[granttap-mcp] HTTP helper listening on ${started.mcpUrl}`,
        "[granttap-mcp] Do not add this URL to ~/.cursor/mcp.json. Cursor uses the GrantTap plugin.",
        "[granttap-mcp] Pair and change settings in the GrantTap plugin and the GrantTap app.",
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
