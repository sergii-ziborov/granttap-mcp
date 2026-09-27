import { startHttpMcpServer } from "../http/http-server";

async function serve(): Promise<void> {
  const started = await startHttpMcpServer();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    // A live HTTP/SSE client can keep server.close() pending after launchd has
    // stopped the wrapper. Bound the shutdown so the old child releases its
    // loopback port before the replacement helper starts.
    const deadline = setTimeout(() => process.exit(0), 3_000);
    void started.close().then(
      () => { clearTimeout(deadline); process.exit(0); },
      () => { clearTimeout(deadline); process.exit(1); },
    );
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
