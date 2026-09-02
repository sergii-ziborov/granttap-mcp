/**
 * GrantTap MCP over Streamable HTTP + loopback OAuth.
 *
 * This is what Cursor Settings needs for the Authorize button (stdio cannot show it).
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
import QRCode from "qrcode";
import { createOneTimePairing, DEFAULT_RELAY } from "../../bridge/src/pairing";
import { createGrantTapServer, relay, resetRelay } from "./create-server";
import { isAllowedLoopbackOrigin } from "./oauth/loopback-origin";
import { GrantTapOAuthProvider } from "./oauth-provider";
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

  app.post("/oauth/pairing", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const origin = req.get("origin");
      if (!isAllowedLoopbackOrigin(origin, issuerUrl.origin)) {
        res.status(403).json({ error: "Cross-origin pairing requests are not allowed." });
        return;
      }
      const pendingId = String(req.body?.pending_id ?? "");
      if (!provider.getPending(pendingId)) {
        res.status(400).json({ error: "Authorization request expired. Start Authorize again from Cursor Settings." });
        return;
      }
      if (isMachineConfigured()) {
        res.json({ ok: true, alreadyPaired: true });
        return;
      }
      const pairing = await createOneTimePairing(
        process.env.GRANTTAP_RELAY_URL ?? process.env.NODVOX_RELAY_URL ?? DEFAULT_RELAY,
        { installHooks: false },
      );
      resetRelay();
      void relay();
      const png = await QRCode.toBuffer(pairing.qrPayload, {
        type: "png",
        width: 480,
        margin: 2,
        errorCorrectionLevel: "L",
      });
      res.json({
        ok: true,
        alreadyPaired: false,
        qrDataUrl: `data:image/png;base64,${png.toString("base64")}`,
        manualToken: pairing.manualToken,
        relay: pairing.httpBase,
        providers: [
          pairing.claude && {
            id: "claude",
            status: pairing.claude.status === "manual" ? "action_required" : "connected",
          },
          pairing.codex && {
            id: "codex",
            status: pairing.codex.status === "manual" ? "action_required" : "connected",
          },
        ].filter(Boolean),
      });
    } catch (error) {
      res.status(500).json({
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
