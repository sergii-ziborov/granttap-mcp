import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHttpMcpServer } from "../apps/mcp/src/http-server";

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function pairingRelay(status = 201) {
  const server = createHttpServer((_request, response) => {
    response.statusCode = status;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function registeredAuthorization(base: string, verifier: string, clientName = "Cursor") {
  const redirectUri = clientName === "Codex"
    ? "http://127.0.0.1:49123/callback/granttap"
    : "http://127.0.0.1:49123/callback";
  const registration = await fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"], response_types: ["code"],
    }),
  });
  const registered = await registration.json() as { client_id: string };
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    client_id: registered.client_id, redirect_uri: redirectUri, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:tools",
    resource: `${base}/mcp`, state: "state",
  }).toString();
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  const website = new URL(response.headers.get("location")!);
  assert.equal(website.origin, "https://granttap.com");
  assert.equal(website.pathname, "/connect");
  const pendingId = new URLSearchParams(website.hash.slice(1)).get("request");
  assert.ok(pendingId);
  return { clientId: registered.client_id, redirectUri, pendingId, website };
}

test("HTTP OAuth pairs, consents, exchanges a token, and initializes MCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-http-flow-"));
  const relay = await pairingRelay();
  const port = await freePort();
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_RELAY_URL = relay.wsUrl;
  process.env.GRANTTAP_SKIP_HOOKS = "1";
  const started = await startHttpMcpServer({ port });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await started.close();
    await relay.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_RELAY_URL;
    delete process.env.GRANTTAP_SKIP_HOOKS;
  });
  const verifier = "v".repeat(64);
  const first = await registeredAuthorization(base, verifier);
  const websiteOrigin = "https://granttap.com";
  const previewOrigin = "https://attacker.test";
  const preflight = await fetch(`${base}/oauth/session`, {
    method: "OPTIONS", headers: {
      origin: websiteOrigin,
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), websiteOrigin);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  const decisionPreflight = await fetch(`${base}/oauth/decision`, {
    method: "OPTIONS", headers: {
      origin: websiteOrigin,
      "access-control-request-method": "POST",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(decisionPreflight.status, 204);
  assert.equal(decisionPreflight.headers.get("access-control-allow-private-network"), "true");
  const blockedSession = await fetch(`${base}/oauth/session?pending_id=${first.pendingId}`, {
    headers: { origin: previewOrigin },
  });
  assert.equal(blockedSession.status, 403);
  const session = await fetch(`${base}/oauth/session?pending_id=${first.pendingId}`, {
    headers: { origin: websiteOrigin },
  });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("access-control-allow-origin"), websiteOrigin);
  const sessionBody = await session.json() as { clientName: string; paired: boolean; providers: unknown[] };
  assert.equal(sessionBody.clientName, "Cursor");
  assert.equal(sessionBody.paired, false);
  assert.ok(sessionBody.providers.some((provider) => (provider as { id?: string }).id === "codex"));
  const foreignConsent = await fetch(`${base}/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.test" },
    body: new URLSearchParams({ pending_id: first.pendingId, decision: "approve" }),
  });
  assert.equal(foreignConsent.status, 403);
  // Older Cursor webviews may still submit consent directly from their own Origin.
  const webviewAuth = await registeredAuthorization(base, verifier);
  const cursorWebviewConsent = await fetch(`${base}/consent`, {
    method: "POST", redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "vscode-webview://anysphere.cursor-mcp",
    },
    body: new URLSearchParams({ pending_id: webviewAuth.pendingId, decision: "deny" }),
  });
  assert.equal(cursorWebviewConsent.status, 302);
  const pairing = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", origin: websiteOrigin,
    }, body: new URLSearchParams({ pending_id: first.pendingId }),
  });
  assert.equal(pairing.status, 200);
  const pairingBody = await pairing.json() as {
    alreadyPaired: boolean; viewId: string; qrDataUrl?: string; manualToken?: string;
  };
  assert.equal(pairingBody.alreadyPaired, false);
  assert.match(pairingBody.viewId, /^[0-9a-f-]{36}$/);
  assert.equal(pairingBody.qrDataUrl, undefined);
  assert.equal(pairingBody.manualToken, undefined);
  const frame = await fetch(`${base}/oauth/pairing/view?view_id=${pairingBody.viewId}`, {
    headers: { origin: websiteOrigin },
  });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("access-control-allow-origin"), null);
  assert.equal(frame.headers.get("x-frame-options"), null);
  assert.match(frame.headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/granttap\.com/);
  assert.equal(frame.headers.get("cache-control"), "no-store");
  const frameHtml = await frame.text();
  assert.match(frameHtml, /data:image\/png;base64,/);
  assert.match(frameHtml, /one-time code/);
  const embedded = await fetch(`${base}/oauth/pairing/view?view_id=${pairingBody.viewId}&embed=1`, {
    headers: { origin: websiteOrigin },
  });
  assert.equal(embedded.status, 200);
  const embeddedHtml = await embedded.text();
  assert.match(embeddedHtml, /data:image\/png;base64,/);
  assert.doesNotMatch(embeddedHtml, /one-time code/);
  const framed = await fetch(`${base}/oauth/pairing/view?view_id=${pairingBody.viewId}`, {
    headers: { origin: websiteOrigin, "sec-fetch-dest": "iframe" },
  });
  assert.doesNotMatch(await framed.text(), /one-time code/);
  const missingFrame = await fetch(`${base}/oauth/pairing/view?view_id=invalid`);
  assert.equal(missingFrame.status, 404);

  const second = await registeredAuthorization(base, verifier);
  const savedPairing = await readFile(join(root, "machine.json"));
  const already = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: second.pendingId }),
  });
  assert.equal((await already.json() as { alreadyPaired: boolean }).alreadyPaired, true);
  assert.deepEqual(await readFile(join(root, "machine.json")), savedPairing);
  const codex = await registeredAuthorization(base, verifier, "Codex");
  assert.equal(new URLSearchParams(codex.website.hash.slice(1)).get("request"), codex.pendingId);
  const foreignReconnect = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.test",
    }, body: new URLSearchParams({ pending_id: codex.pendingId, confirmed: "true" }),
  });
  assert.equal(foreignReconnect.status, 403);
  assert.deepEqual(await readFile(join(root, "machine.json")), savedPairing);
  const reconnect = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", origin: base,
    }, body: new URLSearchParams({ pending_id: codex.pendingId, confirmed: "true" }),
  });
  assert.equal(reconnect.status, 200);
  const newPairing = await reconnect.json() as { alreadyPaired: boolean; qrDataUrl: string };
  assert.equal(newPairing.alreadyPaired, false);
  assert.match(newPairing.qrDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(await readFile(join(root, "machine.json")), savedPairing);
  const replaced = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", origin: base,
    }, body: new URLSearchParams({ pending_id: codex.pendingId, confirmed: "true", replace: "true" }),
  });
  assert.equal(replaced.status, 200);
  assert.equal((await replaced.json() as { alreadyPaired: boolean }).alreadyPaired, false);
  assert.notDeepEqual(await readFile(join(root, "machine.json")), savedPairing);
  const consent = await fetch(`${base}/oauth/decision`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: websiteOrigin },
    body: new URLSearchParams({ pending_id: second.pendingId, decision: "approve" }),
  });
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get("access-control-allow-origin"), websiteOrigin);
  const callback = new URL((await consent.json() as { redirectUrl: string }).redirectUrl);
  const code = callback.searchParams.get("code")!;
  assert.ok(code);
  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: second.clientId, code,
      redirect_uri: second.redirectUri, code_verifier: verifier, resource: `${base}/mcp`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json() as { access_token: string }).access_token;

  const badSession = await fetch(`${base}/mcp`, {
    method: "GET", headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(badSession.status, 400);
  const initialized = await fetch(`${base}/mcp`, {
    method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.headers.get("mcp-session-id"));
  await initialized.text();

  const expiredConsent = await fetch(`${base}/consent`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: "missing", decision: "approve" }),
  });
  assert.equal(expiredConsent.status, 400);
  assert.match(await expiredConsent.text(), /expired/);
});

test("HTTP pairing reports relay rejection without persisting credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-http-flow-error-"));
  const relay = await pairingRelay(503);
  const port = await freePort();
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_RELAY_URL = relay.wsUrl;
  process.env.GRANTTAP_SKIP_HOOKS = "1";
  const started = await startHttpMcpServer({ port });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await started.close();
    await relay.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_RELAY_URL;
    delete process.env.GRANTTAP_SKIP_HOOKS;
  });
  const pending = await registeredAuthorization(base, "x".repeat(64));
  const response = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: pending.pendingId }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json() as { error: string }).error, /HTTP 503/);
});

test("website can open a pairing QR without an authorization request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-http-devices-"));
  const relay = await pairingRelay();
  const port = await freePort();
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_RELAY_URL = relay.wsUrl;
  process.env.GRANTTAP_SKIP_HOOKS = "1";
  const started = await startHttpMcpServer({ port });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await started.close();
    await relay.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_RELAY_URL;
    delete process.env.GRANTTAP_SKIP_HOOKS;
  });
  const pairing = await fetch(`${base}/oauth/pairing`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://granttap.com",
    },
    body: new URLSearchParams(),
  });
  assert.equal(pairing.status, 200);
  const body = await pairing.json() as { alreadyPaired: boolean; viewId: string };
  assert.equal(body.alreadyPaired, false);
  assert.match(body.viewId, /^[0-9a-f-]{36}$/);
});
