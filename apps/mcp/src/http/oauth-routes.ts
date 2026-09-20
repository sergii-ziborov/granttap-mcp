import type { Express } from "express";
import { isAllowedLoopbackOrigin, isWebsiteOrigin } from "../oauth/session/loopback-origin";
import { installPairingRoutes } from "../oauth/consent/pairing-view";
import { GrantTapOAuthProvider } from "../oauth-provider";
import { buildConnectSnapshot, publicClientName } from "../oauth/session/connect-snapshot";
import { isMachineConfigured } from "../status/pairing-status";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function installOAuthBrowserRoutes(
  app: Express,
  provider: GrantTapOAuthProvider,
  issuerUrl: URL,
): void {
  app.use(["/oauth/session", "/oauth/connection", "/oauth/pairing", "/oauth/decision"], (req, res, next) => {
    if (req.originalUrl.split("?", 1)[0] === "/oauth/pairing/view") return next();
    const origin = req.get("origin");
    if (origin && !isWebsiteOrigin(origin)
        && !isAllowedLoopbackOrigin(origin, issuerUrl.origin)) {
      res.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    if (isWebsiteOrigin(origin)) {
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

  app.get("/oauth/connection", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(buildConnectSnapshot("GrantTap"));
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
}
