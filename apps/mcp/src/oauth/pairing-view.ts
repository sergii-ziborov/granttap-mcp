/** Pairing secrets are rendered by the loopback origin, never returned to site JavaScript. */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import QRCode from "qrcode";
import { installMonitorHelper, reloadMonitorHelper } from "../../../bridge/src/install";
import { createOneTimePairing, DEFAULT_RELAY } from "../../../bridge/src/pairing";
import { recordPhoneSeen } from "../../../bridge/src/presence";
import { relay, resetRelay } from "../create-server";
import { buildConnectSnapshot } from "./connect-snapshot";
import { watchMailboxClaim } from "./mailbox-claim";
import { isMachineConfigured } from "../pairing-status";
import type { GrantTapOAuthProvider } from "../oauth-provider";
import { isAllowedLoopbackOrigin, isWebsiteOrigin, WEBSITE_ORIGINS } from "./loopback-origin";

const VIEW_TTL_MS = 15 * 60_000;
type View = { qrDataUrl: string; manualToken: string; expiresAt: number; stopWatch?: () => void };

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderView(view: View, nonce: string, embed: boolean): string {
  if (embed) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrantTap pairing QR</title><style>
html,body{margin:0;height:100%;background:#fff;overflow:hidden}
img{display:block;width:100%;height:100%;object-fit:contain;padding:16px;box-sizing:border-box}
</style></head><body>
<img src="${view.qrDataUrl}" alt="One-time GrantTap pairing QR">
</body></html>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrantTap phone pairing</title><style>
html{color-scheme:dark}body{margin:0;padding:18px;font:16px system-ui,sans-serif;color:#f6f6f6;background:#191919;text-align:center}
img{display:block;box-sizing:border-box;width:min(100%,280px);height:auto;margin:12px auto;padding:12px;background:#fff;border-radius:12px}
code{display:block;overflow-wrap:anywhere;padding:12px;background:#252525;border-radius:8px;user-select:all}
button{padding:10px 18px;border:0;border-radius:8px;background:#f47a45;color:#161616;font-weight:700;cursor:pointer}
</style></head><body><h2>Scan in GrantTap on your iPhone</h2>
<img src="${view.qrDataUrl}" alt="One-time GrantTap pairing QR">
<p>Or enter this one-time code in the app:</p><code id="token">${escapeHtml(view.manualToken)}</code>
<p><button id="copy" type="button">Copy code</button></p>
<script nonce="${nonce}">document.getElementById('copy').addEventListener('click',async()=>{
const button=document.getElementById('copy');try{await navigator.clipboard.writeText(document.getElementById('token').textContent);button.textContent='Copied'}catch{button.textContent='Select the code and copy it'}
});</script></body></html>`;
}

export function installPairingRoutes(app: Express, provider: GrantTapOAuthProvider, issuerOrigin: string): void {
  const views = new Map<string, View>();
  app.post("/oauth/pairing", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const origin = req.get("origin");
      if (!isAllowedLoopbackOrigin(origin, issuerOrigin)) {
        res.status(403).json({ error: "Cross-origin pairing requests are not allowed." });
        return;
      }
      const pendingId = String(req.body?.pending_id ?? "");
      const pending = pendingId ? provider.getPending(pendingId) : undefined;
      if (pendingId && !pending) {
        res.status(400).json({ error: "Authorization request expired. Start authorization again from your MCP client." });
        return;
      }
      if (!pendingId && !isWebsiteOrigin(origin)) {
        res.status(400).json({ error: "Authorization request expired. Start authorization again from your MCP client." });
        return;
      }
      if (isMachineConfigured() && req.body?.confirmed !== "true") {
        res.json({ ok: true, alreadyPaired: true, ...buildConnectSnapshot() });
        return;
      }
      const replace = req.body?.replace === "true";
      const firstPairing = !isMachineConfigured();
      const pairing = await createOneTimePairing(
        process.env.GRANTTAP_RELAY_URL ?? process.env.NODVOX_RELAY_URL ?? DEFAULT_RELAY,
        { installHooks: false, replace },
      );
      resetRelay();
      void relay();
      // The durable LaunchAgent keeps the previous room in memory until reload.
      reloadMonitorHelper();
      if (firstPairing || replace) installMonitorHelper();
      const png = await QRCode.toBuffer(pairing.qrPayload, {
        type: "png", width: 480, margin: 2, errorCorrectionLevel: "L",
      });
      const qrDataUrl = `data:image/png;base64,${png.toString("base64")}`;
      const expiresAt = Date.now() + VIEW_TTL_MS;
      const stopWatch = watchMailboxClaim(pairing.httpBase, pairing.mailboxId, expiresAt, () => {
        recordPhoneSeen();
        resetRelay();
        void relay();
        reloadMonitorHelper();
      });
      if (isWebsiteOrigin(origin)) {
        for (const [id, view] of views) {
          if (view.expiresAt <= Date.now()) {
            view.stopWatch?.();
            views.delete(id);
          }
        }
        if (views.size >= 16) {
          const oldest = views.keys().next().value!;
          views.get(oldest)?.stopWatch?.();
          views.delete(oldest);
        }
        const viewId = randomUUID();
        views.set(viewId, { qrDataUrl, manualToken: pairing.manualToken, expiresAt, stopWatch });
        res.json({ ok: true, alreadyPaired: false, viewId, expiresAt });
        return;
      }
      res.json({
        ok: true, alreadyPaired: false, qrDataUrl, manualToken: pairing.manualToken,
        relay: pairing.httpBase,
        providers: [
          pairing.claude && { id: "claude", status: pairing.claude.status === "manual" ? "action_required" : "connected" },
          pairing.codex && { id: "codex", status: pairing.codex.status === "manual" ? "action_required" : "connected" },
        ].filter(Boolean),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/oauth/pairing/view", (req, res) => {
    const view = views.get(String(req.query.view_id ?? ""));
    if (!view || view.expiresAt <= Date.now()) {
      res.status(404).json({ error: "Pairing code expired. Start again from your coding app." });
      return;
    }
    const nonce = randomUUID().replaceAll("-", "");
    const embed = req.query.embed === "1" || req.get("sec-fetch-dest") === "iframe";
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors ${WEBSITE_ORIGINS.join(" ")}; base-uri 'none'; form-action 'none'`,
    });
    res.type("html").send(renderView(view, nonce, embed));
  });
}
