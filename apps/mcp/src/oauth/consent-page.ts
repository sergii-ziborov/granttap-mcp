import { inspectAgentIntegrations } from "../../../bridge/src/install";

type ConsentOptions = {
  pendingId: string;
  paired: boolean;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
};

type IntegrationRow = {
  id: "claude" | "codex";
  label: string;
  status: "connected" | "action_required" | "not_configured";
  detail: string;
};

function integrationRows(): IntegrationRow[] {
  return inspectAgentIntegrations().map((integration) => ({
    id: integration.agent,
    label: integration.agent === "claude" ? "Claude Code" : "Codex",
    status: integration.agent === "codex" && integration.hookConfigured
      ? "action_required"
      : integration.hookConfigured ? "connected" : integration.installed ? "action_required" : "not_configured",
    detail: integration.agent === "codex" && integration.hookConfigured
      ? "Both hooks installed. Open /hooks, review and trust both GrantTap hooks, then restart Codex."
      : integration.hookConfigured ? "Approval hook installed."
      : integration.installed ? "Run granttap setup to install the approval hook."
      : "Agent was not found on this Mac.",
  }));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function statusCards(paired: boolean): string {
  const rows = [
    { id: "phone", label: "iPhone / Apple Watch", status: "action_required", detail: paired ? "Local E2EE keys exist; live phone reachability is not verified on this page." : "Scan the QR or paste the manual token." },
    { id: "cursor", label: "Cursor", status: "action_required", detail: "Review this local client and approve access below." },
    ...integrationRows(),
  ];
  return rows.map((row) => {
    const label = row.status === "connected" ? "Connected" : row.status === "action_required" ? "Action required" : "Not configured";
    return `<div class="provider"><div><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.detail)}</small></div><span id="status-${row.id}" class="chip ${row.status}">${label}</span></div>`;
  }).join("");
}

export function consentHtml(opts: ConsentOptions): string {
  const { pendingId, paired, clientName, redirectUri, scopes, resource } = opts;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Authorize GrantTap</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1419;color:#e8eef4}main{width:min(520px,92vw);padding:28px;border-radius:16px;background:#1a222c;box-shadow:0 16px 48px #0008}h1{font-size:1.25rem;margin:0 0 8px}p{margin:0 0 16px;line-height:1.45;color:#b7c4d2;font-size:.95rem}#qr{display:none;margin:0 auto 16px;width:240px;height:240px;background:#fff;border-radius:12px;padding:10px;box-sizing:border-box}#qr img{width:100%;height:100%;object-fit:contain}.client{padding:12px;border:1px solid #334151;border-radius:10px;background:#121920;margin-bottom:16px}.client strong,.client code{display:block;overflow-wrap:anywhere}.client code{margin-top:4px;color:#9fb0c0;font-size:.75rem}.providers{display:grid;gap:8px;margin:0 0 18px}.provider{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #334151;border-radius:10px}.provider strong,.provider small{display:block}.provider small{margin-top:3px;color:#8fa3b8}.chip{flex:none;padding:4px 7px;border:1px solid;border-radius:999px;font-size:.65rem;font-weight:750;text-transform:uppercase}.connected{color:#68d39c;border-color:#68d39c66}.action_required{color:#f0bb7b;border-color:#f0bb7b66}.not_configured{color:#8fa3b8;border-color:#8fa3b866}#manual{display:none;margin:0 0 16px;padding:12px;border:1px solid #334151;border-radius:10px}#manual code{display:block;margin:7px 0;padding:8px;overflow-wrap:anywhere;background:#0c1117;border-radius:7px;user-select:all}.row{display:flex;gap:10px}button{flex:1;border:0;border-radius:10px;padding:12px 14px;font-weight:600;cursor:pointer}.approve{background:#3d8bfd;color:#fff}.deny{background:#2a3440;color:#d7e0ea}.status{font-size:.85rem;color:#8fa3b8;min-height:1.2em}</style></head>
<body><main><h1>Authorize ${escapeHtml(clientName)} → GrantTap</h1><p>Grant this local MCP client access to GrantTap tools on this Mac. E2EE keys stay local in <code>~/.granttap</code>.</p><div class="client"><strong>Requesting client: ${escapeHtml(clientName)}</strong><code>Permission: ${escapeHtml(scopes.join(" "))}</code><code>Resource: ${escapeHtml(resource)}</code><code>Redirect: ${escapeHtml(redirectUri)}</code></div><div class="providers">${statusCards(paired)}</div><div id="qr"></div><div id="manual"><strong>Camera unavailable?</strong><span> Paste this one-time token in the GrantTap app:</span><code id="manual-code"></code><button type="button" id="copy-token">Copy token</button></div><p class="status" id="status">${paired ? "Local pairing keys found; phone reachability is not verified here." : "Creating a pairing QR…"}</p><p>Approve grants this MCP client local tool access. It does not prove that the phone has scanned the pairing code.</p><form id="form" method="POST" action="/consent" class="row"><input type="hidden" name="pending_id" value="${pendingId}" /><button class="deny" type="submit" name="decision" value="deny">Deny</button><button class="approve" type="submit" name="decision" value="approve" id="approve" ${paired ? "" : "disabled"}>Approve</button></form></main>
<script>const paired=${paired ? "true" : "false"};const status=document.getElementById("status");const approve=document.getElementById("approve");const qrBox=document.getElementById("qr");const manualBox=document.getElementById("manual");const manualCode=document.getElementById("manual-code");const copyToken=document.getElementById("copy-token");copyToken.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(manualCode.textContent||"");status.textContent="Manual token copied. It expires after 15 minutes."}catch{status.textContent="Select the manual token and copy it."}});async function ensurePairing(){if(paired)return;const body=new URLSearchParams({pending_id:${JSON.stringify(pendingId)}});const res=await fetch("/oauth/pairing",{method:"POST",body});const data=await res.json();if(!res.ok){status.textContent=data.error||"Pairing failed";return}if(data.alreadyPaired){status.textContent="Local pairing keys found. Review the client and Approve; verify the phone with a live request.";approve.disabled=false;return}qrBox.style.display="block";qrBox.innerHTML='<img alt="GrantTap pairing QR" src="'+data.qrDataUrl+'" />';manualCode.textContent=data.manualToken;manualBox.style.display="block";for(const provider of data.providers||[]){const chip=document.getElementById("status-"+provider.id);if(!chip)continue;chip.textContent=provider.status==="connected"?"Connected":"Action required";chip.className="chip "+provider.status}status.textContent="Scan with GrantTap on iPhone, then Approve.";approve.disabled=false}ensurePairing().catch((err)=>{status.textContent=String(err)});</script></body></html>`;
}
