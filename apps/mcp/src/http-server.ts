/**
 * GrantTap MCP over Streamable HTTP + loopback OAuth with website consent.
 *
 * Codex, Claude Code, Cursor and Grok Build can discover this OAuth endpoint.
 * Bind is loopback-only. Pairing keys remain in ~/.granttap.
 */
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createGrantTapServer, relay, resetRelay } from "./create-server";
import { isAllowedLoopbackOrigin } from "./oauth/loopback-origin";
import { installPairingRoutes } from "./oauth/pairing-view";
import { GrantTapOAuthProvider } from "./oauth-provider";
import { buildConnectSnapshot, publicClientName } from "./oauth/connect-snapshot";
import { resetConnectWatchers } from "./oauth/website-session";
import { isMachineConfigured } from "./pairing-status";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 17342;

type ServeOptions = {
  host?: string;
  port?: number;
};

export async function startHttpMcpServer(options: ServeOptions = {}): Promise<{
  host: string;
  port: number;
  mcpUrl: string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? process.env.GRANTTAP_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("GrantTap HTTP MCP must bind to loopback (127.0.0.1 / localhost / ::1)");
  }
  const port = options.port
    ?? Number(process.env.GRANTTAP_MCP_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GrantTap HTTP MCP port must be an integer between 1 and 65535");
  }

  const mcpUrl = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}/mcp`);
  const issuerUrl = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}`);
  const provider = new GrantTapOAuthProvider(mcpUrl.href);
  const app = createMcpExpressApp({ host });

  app.use(express.urlencoded({ extended: false }));

  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: ["mcp:tools"],
    resourceName: "GrantTap MCP",
    serviceDocumentationUrl: new URL("https://granttap.com"),
  }));

  // The public website is the only browser origin allowed to read a pending
  // authorization. The random pending id lives in the website URL fragment,
  // never in a request to the website server.
  app.use(["/oauth/session", "/oauth/pairing", "/oauth/decision"], (req, res, next) => {
    if (req.originalUrl.split("?", 1)[0] === "/oauth/pairing/view") return next();
    const origin = req.get("origin");
    if (origin && origin !== "https://granttap.com"
        && !isAllowedLoopbackOrigin(origin, issuerUrl.origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    if (origin === "https://granttap.com") {
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Vary": "Origin, Access-Control-Request-Private-Network",
      });
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/oauth/session", (req, res) => {
    res.set("Cache-Control", "no-store");
    const pending = provider.getPending(String(req.query.pending_id ?? ""));
    if (!pending) {
      res.status(404).json({
        error: "This connection request expired. Start again in your coding app.",
        expired: true,
        paired: isMachineConfigured(),
      });
      return;
    }
    res.json({
      ...buildConnectSnapshot(pending.client.client_name),
      clientName: publicClientName(pending.client.client_name),
    });
  });

  installPairingRoutes(app, provider, issuerUrl.origin);

  app.post("/oauth/decision", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("origin") !== "https://granttap.com") {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    try {
      const pendingId = String(req.body?.pending_id ?? "");
      const decision = String(req.body?.decision ?? "");
      if (decision !== "approve" && decision !== "deny") {
        res.status(400).json({ error: "Choose Approve or Deny." });
        return;
      }
      const { redirectUrl } = provider.completeConsent(pendingId, decision === "approve");
      res.json({ redirectUrl });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/consent", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const origin = req.get("origin");
      if (!isAllowedLoopbackOrigin(origin, issuerUrl.origin)) {
        res.status(403).type("html").send("<!DOCTYPE html><html><body><p>Cross-origin consent is not allowed.</p></body></html>");
        return;
      }
      const pendingId = String(req.body?.pending_id ?? "");
      const decision = String(req.body?.decision ?? "");
      const { redirectUrl } = provider.completeConsent(pendingId, decision === "approve");
      res.redirect(302, redirectUrl);
    } catch (error) {
      res.status(400).type("html").send(
        `<!DOCTYPE html><html><body><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></body></html>`,
      );
    }
  });

  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpHandler = async (req: express.Request, res: express.Response): Promise<void> => {
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

  app.post("/mcp", authMiddleware, mcpHandler);
  app.get("/mcp", authMiddleware, mcpHandler);
  app.delete("/mcp", authMiddleware, mcpHandler);

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const pairingKeysPresent = isMachineConfigured();
    res.json({
      schema: "granttap.http-health.v1",
      ok: true,
      service: "granttap-mcp",
      paired: pairingKeysPresent,
      pairingKeysPresent,
      phoneReachability: "unknown",
      mcp: mcpUrl.href,
    });
  });

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve(httpServer));
    httpServer.on("error", reject);
  });

  void relay();

  return {
    host,
    port,
    mcpUrl: mcpUrl.href,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
      resetConnectWatchers();
      resetRelay();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
