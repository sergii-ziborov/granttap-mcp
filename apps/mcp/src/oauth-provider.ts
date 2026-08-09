/**
 * Loopback OAuth 2.1 provider for Cursor Settings → Authorize.
 *
 * Authorize means: confirm this Mac's GrantTap pairing for Cursor (issue a
 * bearer token). E2EE keys stay in ~/.granttap — OAuth does not replace pair.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { configDir } from "../../bridge/src/config";
import { inspectAgentIntegrations } from "../../bridge/src/install";
import { isMachineConfigured } from "./pairing-status";

type PendingAuth = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
};

type StoredClient = OAuthClientInformationFull;
type StoredCode = {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
};
type StoredToken = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
};

type OAuthStoreFile = {
  clients: Record<string, StoredClient>;
  tokens: Record<string, StoredToken>;
};

const CODE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const PENDING_TTL_MS = 15 * 60_000;

function storePath(): string {
  return join(configDir(), "mcp-oauth.json");
}

function loadStore(): OAuthStoreFile {
  try {
    if (!existsSync(storePath())) return { clients: {}, tokens: {} };
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as OAuthStoreFile;
    return {
      clients: raw.clients ?? {},
      tokens: raw.tokens ?? {},
    };
  } catch {
    return { clients: {}, tokens: {} };
  }
}

function saveStore(store: OAuthStoreFile): void {
  mkdirSync(configDir(), { recursive: true });
  const path = storePath();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class GrantTapClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return loadStore().clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const store = loadStore();
    store.clients[client.client_id] = client;
    saveStore(store);
    return client;
  }
}

export class GrantTapOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new GrantTapClientsStore();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, StoredCode>();

  constructor(private readonly expectedResource?: string) {}

  /** Begin auth: stash params and return a pending id for the consent page. */
  createPending(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    this.gcPending();
    const id = randomUUID();
    this.pending.set(id, { client, params, createdAt: Date.now() });
    return id;
  }

  getPending(id: string): PendingAuth | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
      this.pending.delete(id);
      return undefined;
    }
    return entry;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // redirect_uri already validated by the SDK authorization handler.
    const scopes = params.scopes?.length ? params.scopes : ["mcp:tools"];
    if (scopes.some((scope) => scope !== "mcp:tools")) {
      throw new InvalidScopeError("GrantTap supports only the mcp:tools scope");
    }
    if (this.expectedResource && params.resource
        && params.resource.href !== this.expectedResource) {
      throw new InvalidTargetError("The requested resource is not this GrantTap MCP endpoint");
    }
    const normalizedParams: AuthorizationParams = {
      ...params,
      scopes,
      resource: this.expectedResource ? new URL(this.expectedResource) : params.resource,
    };
    const pendingId = this.createPending(client, normalizedParams);
    const paired = isMachineConfigured();
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    });
    res.status(200).type("html").send(consentHtml({
      pendingId,
      paired,
      clientName: client.client_name?.trim() || "Unknown local MCP client",
      redirectUri: normalizedParams.redirectUri,
      scopes: normalizedParams.scopes ?? [],
      resource: normalizedParams.resource?.href ?? "local GrantTap MCP",
    }));
  }

  /** Complete consent: issue code and redirect to Cursor. */
  completeConsent(pendingId: string, approve: boolean): { redirectUrl: string } {
    const pending = this.getPending(pendingId);
    if (!pending) throw new Error("Authorization request expired. Start Authorize again from Cursor Settings.");

    const target = new URL(pending.params.redirectUri);
    if (!approve) {
      this.pending.delete(pendingId);
      target.searchParams.set("error", "access_denied");
      if (pending.params.state) target.searchParams.set("state", pending.params.state);
      return { redirectUrl: target.toString() };
    }
    if (!isMachineConfigured()) {
      throw new Error("GrantTap is not paired on this Mac yet. Scan the QR, then Approve.");
    }

    this.pending.delete(pendingId);
    const code = randomUUID();
    this.codes.set(code, {
      clientId: pending.client.client_id,
      params: pending.params,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    target.searchParams.set("code", code);
    if (pending.params.state) target.searchParams.set("state", pending.params.state);
    return { redirectUrl: target.toString() };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const data = this.codes.get(authorizationCode);
    if (!data || data.expiresAt < Date.now()) {
      if (data) this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (data.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code client mismatch");
    }
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const data = this.codes.get(authorizationCode);
    if (!data || data.expiresAt < Date.now()) {
      if (data) this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (data.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code client mismatch");
    }
    if (redirectUri && redirectUri !== data.params.redirectUri) {
      throw new InvalidGrantError("Authorization code redirect URI mismatch");
    }
    if (resource && resource.href !== data.params.resource?.href) {
      throw new InvalidTargetError("Authorization code resource mismatch");
    }
    this.codes.delete(authorizationCode);

    const token = randomUUID();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const store = loadStore();
    store.tokens[token] = {
      clientId: client.client_id,
      scopes: data.params.scopes ?? ["mcp:tools"],
      expiresAt,
      resource: data.params.resource?.href,
    };
    saveStore(store);

    return {
      access_token: token,
      token_type: "bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      scope: (data.params.scopes ?? ["mcp:tools"]).join(" "),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("Refresh tokens are not issued by GrantTap local OAuth");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const store = loadStore();
    const data = store.tokens[token];
    if (!data) throw new InvalidTokenError("Invalid or expired token");
    if (data.expiresAt < Date.now()) {
      delete store.tokens[token];
      saveStore(store);
      throw new InvalidTokenError("Invalid or expired token");
    }
    if (this.expectedResource && data.resource !== this.expectedResource) {
      throw new InvalidTokenError("Token was issued for another resource");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      resource: data.resource ? new URL(data.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: { token: string },
  ): Promise<void> {
    const store = loadStore();
    if (store.tokens[request.token]?.clientId === client.client_id) {
      delete store.tokens[request.token];
      saveStore(store);
    }
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    }
  }
}

function integrationRows(): Array<{
  id: "claude" | "codex";
  label: string;
  status: "connected" | "action_required" | "not_configured";
  detail: string;
}> {
  return inspectAgentIntegrations().map((integration) => ({
    id: integration.agent,
    label: integration.agent === "claude" ? "Claude Code" : "Codex",
    status: integration.agent === "codex" && integration.hookConfigured
      ? "action_required"
      : integration.hookConfigured
        ? "connected"
      : integration.installed
        ? "action_required"
        : "not_configured",
    detail: integration.agent === "codex" && integration.hookConfigured
      ? "Both hooks installed. Open /hooks, review and trust both GrantTap hooks, then restart Codex."
      : integration.hookConfigured
        ? "Approval hook installed."
      : integration.installed
        ? "Run granttap setup to install the approval hook."
        : "Agent was not found on this Mac.",
  }));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function consentHtml(opts: {
  pendingId: string;
  paired: boolean;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
}): string {
  const { pendingId, paired, clientName, redirectUri, scopes, resource } = opts;
  const rows = [
    {
      id: "phone",
      label: "iPhone / Apple Watch",
      status: "action_required",
      detail: paired
        ? "Local E2EE keys exist; live phone reachability is not verified on this page."
        : "Scan the QR or paste the manual token.",
    },
    {
      id: "cursor",
      label: "Cursor",
      status: "action_required",
      detail: "Review this local client and approve access below.",
    },
    ...integrationRows(),
  ];
  const statusCards = rows.map((row) => {
    const label = row.status === "connected"
      ? "Connected"
      : row.status === "action_required"
        ? "Action required"
        : "Not configured";
    return `<div class="provider"><div><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.detail)}</small></div><span id="status-${row.id}" class="chip ${row.status}">${label}</span></div>`;
  }).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize GrantTap</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1419; color: #e8eef4; }
    main { width: min(520px, 92vw); padding: 28px; border-radius: 16px; background: #1a222c; box-shadow: 0 16px 48px #0008; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { margin: 0 0 16px; line-height: 1.45; color: #b7c4d2; font-size: 0.95rem; }
    #qr { display: none; margin: 0 auto 16px; width: 240px; height: 240px; background: #fff; border-radius: 12px; padding: 10px; box-sizing: border-box; }
    #qr img { width: 100%; height: 100%; object-fit: contain; }
    .client { padding: 12px; border: 1px solid #334151; border-radius: 10px; background: #121920; margin-bottom: 16px; }
    .client strong, .client code { display: block; overflow-wrap: anywhere; }
    .client code { margin-top: 4px; color: #9fb0c0; font-size: .75rem; }
    .providers { display: grid; gap: 8px; margin: 0 0 18px; }
    .provider { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid #334151; border-radius: 10px; }
    .provider strong, .provider small { display: block; }.provider small { margin-top: 3px; color: #8fa3b8; }
    .chip { flex: none; padding: 4px 7px; border: 1px solid; border-radius: 999px; font-size: .65rem; font-weight: 750; text-transform: uppercase; }
    .connected { color: #68d39c; border-color: #68d39c66; }.action_required { color: #f0bb7b; border-color: #f0bb7b66; }.not_configured { color: #8fa3b8; border-color: #8fa3b866; }
    #manual { display: none; margin: 0 0 16px; padding: 12px; border: 1px solid #334151; border-radius: 10px; }
    #manual code { display: block; margin: 7px 0; padding: 8px; overflow-wrap: anywhere; background: #0c1117; border-radius: 7px; user-select: all; }
    .row { display: flex; gap: 10px; }
    button { flex: 1; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 600; cursor: pointer; }
    .approve { background: #3d8bfd; color: #fff; }
    .deny { background: #2a3440; color: #d7e0ea; }
    .status { font-size: 0.85rem; color: #8fa3b8; min-height: 1.2em; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${escapeHtml(clientName)} → GrantTap</h1>
    <p>Grant this local MCP client access to GrantTap tools on this Mac. E2EE keys stay local in <code>~/.granttap</code>.</p>
    <div class="client"><strong>Requesting client: ${escapeHtml(clientName)}</strong><code>Permission: ${escapeHtml(scopes.join(" "))}</code><code>Resource: ${escapeHtml(resource)}</code><code>Redirect: ${escapeHtml(redirectUri)}</code></div>
    <div class="providers">${statusCards}</div>
    <div id="qr"></div>
    <div id="manual"><strong>Camera unavailable?</strong><span> Paste this one-time token in the GrantTap app:</span><code id="manual-code"></code><button type="button" id="copy-token">Copy token</button></div>
    <p class="status" id="status">${paired ? "Local pairing keys found; phone reachability is not verified here." : "Creating a pairing QR…"}</p>
    <p>Approve grants this MCP client local tool access. It does not prove that the phone has scanned the pairing code.</p>
    <form id="form" method="POST" action="/consent" class="row">
      <input type="hidden" name="pending_id" value="${pendingId}" />
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve" id="approve" ${paired ? "" : "disabled"}>Approve</button>
    </form>
  </main>
  <script>
    const paired = ${paired ? "true" : "false"};
    const status = document.getElementById("status");
    const approve = document.getElementById("approve");
    const qrBox = document.getElementById("qr");
    const manualBox = document.getElementById("manual");
    const manualCode = document.getElementById("manual-code");
    const copyToken = document.getElementById("copy-token");
    copyToken.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(manualCode.textContent || "");
        status.textContent = "Manual token copied. It expires after 15 minutes.";
      } catch {
        status.textContent = "Select the manual token and copy it.";
      }
    });
    async function ensurePairing() {
      if (paired) return;
      const body = new URLSearchParams({ pending_id: ${JSON.stringify(pendingId)} });
      const res = await fetch("/oauth/pairing", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || "Pairing failed";
        return;
      }
      if (data.alreadyPaired) {
        status.textContent = "Local pairing keys found. Review the client and Approve; verify the phone with a live request.";
        approve.disabled = false;
        return;
      }
      qrBox.style.display = "block";
      qrBox.innerHTML = '<img alt="GrantTap pairing QR" src="' + data.qrDataUrl + '" />';
      manualCode.textContent = data.manualToken;
      manualBox.style.display = "block";
      for (const provider of data.providers || []) {
        const chip = document.getElementById("status-" + provider.id);
        if (!chip) continue;
        chip.textContent = provider.status === "connected" ? "Connected" : "Action required";
        chip.className = "chip " + provider.status;
      }
      status.textContent = "Scan with GrantTap on iPhone, then Approve.";
      approve.disabled = false;
    }
    ensurePairing().catch((err) => {
      status.textContent = String(err);
    });
  </script>
</body>
</html>`;
}
