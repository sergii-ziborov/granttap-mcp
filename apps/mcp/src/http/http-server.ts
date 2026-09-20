/**
 * GrantTap MCP over Streamable HTTP + loopback OAuth with website consent.
 *
 * Codex, Claude Code, Cursor and Grok Build can discover this OAuth endpoint.
 * Bind is loopback-only. Pairing keys remain in ~/.granttap.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import { relay, resetRelay } from "./create-server";
import { resetPairingWatches } from "../oauth/consent/pairing-view";
import { GrantTapOAuthProvider } from "../oauth-provider";
import { resetConnectWatchers } from "../oauth/consent/website-session";
import { isMachineConfigured, phoneReachability } from "../status/pairing-status";
import { installOAuthBrowserRoutes } from "./oauth-routes";
import { createMcpSessionHandler } from "./mcp-handler";

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
  installOAuthBrowserRoutes(app, provider, issuerUrl);
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  const sessions = createMcpSessionHandler();
  app.post("/mcp", authMiddleware, sessions.handler);
  app.get("/mcp", authMiddleware, sessions.handler);
  app.delete("/mcp", authMiddleware, sessions.handler);
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const pairingKeysPresent = isMachineConfigured();
    res.json({
      schema: "granttap.http-health.v1",
      ok: true,
      service: "granttap-mcp",
      paired: pairingKeysPresent,
      pairingKeysPresent,
      phoneReachability: phoneReachability(),
      mcp: mcpUrl.href,
    });
  });

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve(httpServer));
    httpServer.on("error", reject);
  });

  provider.resumeConnectWatches();
  void relay();

  return {
    host,
    port,
    mcpUrl: mcpUrl.href,
    close: async () => {
      await sessions.close();
      resetConnectWatchers();
      resetPairingWatches();
      resetRelay();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
