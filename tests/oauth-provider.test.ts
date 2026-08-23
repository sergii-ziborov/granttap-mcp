import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createPairing, machineConfigPath, phonePairingPath, saveConfig } from "../apps/bridge/src/config";
import { GrantTapOAuthProvider } from "../apps/mcp/src/oauth-provider";
import { loadOAuthStore, saveOAuthStore } from "../apps/mcp/src/oauth/store";

const resource = "http://127.0.0.1:17342/mcp";
const client = {
  client_id: "cursor-client", client_name: "Cursor", redirect_uris: ["http://127.0.0.1:49123/callback"],
} as OAuthClientInformationFull;
const params = {
  redirectUri: client.redirect_uris[0]!, codeChallenge: "A".repeat(43),
  scopes: ["mcp:tools"], state: "state-1", resource: new URL(resource),
} as AuthorizationParams;

function responseRecorder(): { response: Response; body: () => string; status: () => number } {
  let body = "";
  let status = 0;
  const response = {
    set: () => response,
    status: (value: number) => { status = value; return response; },
    type: () => response,
    send: (value: string) => { body = value; return response; },
  } as unknown as Response;
  return { response, body: () => body, status: () => status };
}

test("OAuth provider completes consent, code exchange, verification, and revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-oauth-provider-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => delete process.env.GRANTTAP_CONFIG_DIR);
  const provider = new GrantTapOAuthProvider(resource);

  const deniedId = provider.createPending(client, params);
  const denied = provider.completeConsent(deniedId, false);
  assert.equal(new URL(denied.redirectUrl).searchParams.get("error"), "access_denied");
  assert.equal(new URL(denied.redirectUrl).searchParams.get("state"), "state-1");
  assert.throws(() => provider.completeConsent("missing", true), /expired/);

  const unpaired = provider.createPending(client, params);
  assert.throws(() => provider.completeConsent(unpaired, true), /not paired/);
  const paired = createPairing("wss://relay.example.test");
  saveConfig(machineConfigPath(), paired.machineCfg);
  saveConfig(phonePairingPath(), paired.phoneCfg);

  const record = responseRecorder();
  await provider.authorize(client, { ...params, scopes: [] }, record.response);
  assert.equal(record.status(), 200);
  assert.match(record.body(), /Cursor/);
  assert.match(record.body(), /mcp:tools/);
  await assert.rejects(
    provider.authorize(client, { ...params, scopes: ["admin"] }, record.response),
    /mcp:tools scope/,
  );
  await assert.rejects(
    provider.authorize(client, { ...params, resource: new URL("http://127.0.0.1:1/mcp") }, record.response),
    /not this GrantTap MCP endpoint/,
  );

  const pendingId = provider.createPending(client, params);
  const approved = provider.completeConsent(pendingId, true);
  const code = new URL(approved.redirectUrl).searchParams.get("code")!;
  assert.ok(code);
  assert.equal(await provider.challengeForAuthorizationCode(client, code), params.codeChallenge);
  await assert.rejects(
    provider.challengeForAuthorizationCode({ ...client, client_id: "other" }, code), /client mismatch/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(client, "missing"), /Invalid or expired/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode({ ...client, client_id: "other" }, code), /client mismatch/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(client, code, undefined, "http://wrong.test"), /redirect URI mismatch/,
  );
  await assert.rejects(
    provider.exchangeAuthorizationCode(client, code, undefined, params.redirectUri, new URL("http://wrong.test")),
    /resource mismatch/,
  );
  const tokens = await provider.exchangeAuthorizationCode(
    client, code, undefined, params.redirectUri, new URL(resource),
  );
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.scope, "mcp:tools");
  const verified = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(verified.clientId, client.client_id);
  assert.equal(verified.resource?.href, resource);
  await assert.rejects(provider.verifyAccessToken("missing"), /Invalid or expired/);
  await assert.rejects(
    new GrantTapOAuthProvider("http://127.0.0.1:1/mcp").verifyAccessToken(tokens.access_token),
    /another resource/,
  );

  await provider.revokeToken({ ...client, client_id: "other" }, { token: tokens.access_token });
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  await provider.revokeToken(client, { token: tokens.access_token });
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid or expired/);
  await assert.rejects(provider.exchangeRefreshToken(), /not issued/);
});

test("OAuth provider expires stale pending requests, codes, and tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-oauth-expiry-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => delete process.env.GRANTTAP_CONFIG_DIR);
  const provider = new GrantTapOAuthProvider(resource);
  const pendingId = provider.createPending(client, params);
  const internals = provider as unknown as {
    pending: Map<string, { createdAt: number }>;
    codes: Map<string, { clientId: string; params: AuthorizationParams; expiresAt: number }>;
  };
  internals.pending.get(pendingId)!.createdAt = 0;
  assert.equal(provider.getPending(pendingId), undefined);
  provider.createPending(client, params);
  internals.codes.set("expired-code", { clientId: client.client_id, params, expiresAt: 0 });
  await assert.rejects(provider.challengeForAuthorizationCode(client, "expired-code"), /expired/);
  internals.codes.set("expired-exchange", { clientId: client.client_id, params, expiresAt: 0 });
  await assert.rejects(provider.exchangeAuthorizationCode(client, "expired-exchange"), /expired/);

  const store = loadOAuthStore();
  store.tokens.expired = {
    clientId: client.client_id, scopes: ["mcp:tools"], expiresAt: 0, resource,
  };
  saveOAuthStore(store);
  await assert.rejects(provider.verifyAccessToken("expired"), /expired/);
  assert.equal(loadOAuthStore().tokens.expired, undefined);
});
