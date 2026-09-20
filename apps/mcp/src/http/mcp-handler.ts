import { randomUUID } from "node:crypto";
import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createGrantTapServer } from "./create-server";

export function createMcpSessionHandler(): {
  handler: (req: express.Request, res: express.Response) => Promise<void>;
  close: () => Promise<void>;
} {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const handler = async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (typeof sessionId === "string" && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) transports.delete(id);
        };
        const server = createGrantTapServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
          id: null,
        });
      }
    }
  };
  return {
    handler,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
    },
  };
}
