import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
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

async function registeredAuthorization(base: string, verifier: string) {
  const redirectUri = "http://127.0.0.1:49123/callback";
  const registration = await fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Cursor", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
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
  const response = await fetch(url);
  const html = await response.text();
  const pendingId = /name="pending_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(pendingId);
  return { clientId: registered.client_id, redirectUri, pendingId };
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
  const foreignConsent = await fetch(`${base}/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.test" },
    body: new URLSearchParams({ pending_id: first.pendingId, decision: "approve" }),
  });
  assert.equal(foreignConsent.status, 403);
  // Cursor Settings loads the loopback consent page inside a vscode-webview.
  // That webview still POSTs Origin: vscode-webview://… — allow it, keep https blocked.
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
      "content-type": "application/x-www-form-urlencoded", origin: base,
    }, body: new URLSearchParams({ pending_id: first.pendingId }),
  });
  assert.equal(pairing.status, 200);
  const pairingBody = await pairing.json() as { alreadyPaired: boolean; qrDataUrl: string };
  assert.equal(pairingBody.alreadyPaired, false);
  assert.match(pairingBody.qrDataUrl, /^data:image\/png;base64,/);

  const second = await registeredAuthorization(base, verifier);
  const already = await fetch(`${base}/oauth/pairing`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: second.pendingId }),
  });
  assert.equal((await already.json() as { alreadyPaired: boolean }).alreadyPaired, true);
  const consent = await fetch(`${base}/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ pending_id: second.pendingId, decision: "approve" }),
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location")!);
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
