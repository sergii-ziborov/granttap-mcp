/**
 * Loopback OAuth 2.1 provider for Cursor Settings → Authorize.
 *
 * Authorize means: confirm this Mac's GrantTap pairing for Cursor (issue a
 * bearer token). E2EE keys stay in ~/.granttap — OAuth does not replace pair.
 */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
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
import { isMachineConfigured } from "./pairing-status";
import { consentHtml } from "./oauth/consent-page";
import { GrantTapClientsStore, loadOAuthStore, saveOAuthStore } from "./oauth/store";

type PendingAuth = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
};

type StoredCode = {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
};
const CODE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const PENDING_TTL_MS = 15 * 60_000;
export { GrantTapClientsStore } from "./oauth/store";

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
    const store = loadOAuthStore();
    store.tokens[token] = {
      clientId: client.client_id,
      scopes: data.params.scopes ?? ["mcp:tools"],
      expiresAt,
      resource: data.params.resource?.href,
    };
    saveOAuthStore(store);

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
    const store = loadOAuthStore();
    const data = store.tokens[token];
    if (!data) throw new InvalidTokenError("Invalid or expired token");
    if (data.expiresAt < Date.now()) {
      delete store.tokens[token];
      saveOAuthStore(store);
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
    const store = loadOAuthStore();
    if (store.tokens[request.token]?.clientId === client.client_id) {
      delete store.tokens[request.token];
      saveOAuthStore(store);
    }
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(id);
    }
  }
}
