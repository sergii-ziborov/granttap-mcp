/**
 * Loopback Streamable HTTP MCP for Cursor Authorize.
 *
 * Listens on http://127.0.0.1:17342/mcp by default. Cursor plugin mcp.json must
 * use type "http" (not stdio) so Plugins shows Authorize.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createGrantTapServer, startGrantTapBackground } from "./create-server";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 17342;
export const DEFAULT_HTTP_PATH = "/mcp";

type ExpressReq = IncomingMessage & { body?: unknown };
type ExpressRes = ServerResponse & {
  headersSent: boolean;
  status: (code: number) => { json: (body: unknown) => void };
};

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
}

async function main(): Promise<void> {
  const host = process.env.GRANTTAP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const port = Number(process.env.GRANTTAP_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  const path = process.env.GRANTTAP_HTTP_PATH ?? DEFAULT_HTTP_PATH;

  const app = createMcpExpressApp({ host });

  app.post(path, async (req: ExpressReq, res: ExpressRes) => {
    const server = createGrantTapServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      process.stderr.write(
        `[granttap-mcp] HTTP MCP error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get(path, (_req: ExpressReq, res: ExpressRes) => methodNotAllowed(res));
  app.delete(path, (_req: ExpressReq, res: ExpressRes) => methodNotAllowed(res));

  startGrantTapBackground();

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve());
    httpServer.on("error", reject);
  });

  process.stderr.write(
    `[granttap-mcp] HTTP MCP listening on http://${host}:${port}${path} (Cursor Authorize)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[granttap-mcp] ${(err as Error).message}\n`);
  process.exit(1);
});
