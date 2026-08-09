import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHttpMcpServer } from "../apps/mcp/src/http-server";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

test("HTTP MCP rejects invalid or non-loopback listeners", async () => {
  await assert.rejects(
    startHttpMcpServer({ host: "0.0.0.0", port: 17342 }),
    /loopback/,
  );
  await assert.rejects(
    startHttpMcpServer({ host: "127.0.0.1", port: 0 }),
    /integer between 1 and 65535/,
  );
});

test("HTTP MCP OAuth discovery matches Cursor Authorize requirements", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-http-oauth-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  const port = await freePort();
  const started = await startHttpMcpServer({ host: "127.0.0.1", port });
  t.after(() => started.close());

  const base = `http://127.0.0.1:${port}`;

  const unauth = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "granttap-test", version: "0" },
      },
    }),
  });
  assert.equal(unauth.status, 401);
  const www = unauth.headers.get("www-authenticate") ?? "";
  assert.match(www, /resource_metadata=/i);
  assert.match(www, /oauth-protected-resource/i);

  const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  const prmJson = await prm.json() as {
    resource: string;
    authorization_servers: string[];
    resource_name?: string;
  };
  assert.equal(prmJson.resource, `${base}/mcp`);
  assert.ok(prmJson.authorization_servers.some((value) => value.replace(/\/$/, "") === base));
  assert.equal(prmJson.resource_name, "GrantTap MCP");

  const asMeta = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(asMeta.status, 200);
  const asJson = await asMeta.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
  };
  assert.equal(asJson.issuer.replace(/\/$/, ""), base);
  assert.equal(asJson.authorization_endpoint, `${base}/authorize`);
  assert.equal(asJson.token_endpoint, `${base}/token`);
  assert.ok(asJson.registration_endpoint, "DCR required for Cursor without static CLIENT_ID");

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  const healthJson = await health.json() as {
    schema: string;
    ok: boolean;
    service: string;
    mcp: string;
  };
  assert.equal(healthJson.schema, "granttap.http-health.v1");
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, "granttap-mcp");
  assert.equal(healthJson.mcp, `${base}/mcp`);

  const pairingWithoutAuth = await fetch(`${base}/oauth/pairing`, { method: "POST" });
  assert.equal(pairingWithoutAuth.status, 400);

  const clientName = "<script>not Cursor</script>";
  const redirectUri = "http://127.0.0.1:49123/callback";
  const registration = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { client_id: string };
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    scope: "mcp:tools",
    resource: `${base}/mcp`,
    state: "state-1",
  }).toString();
  const authorize = await fetch(authorizeUrl);
  assert.equal(authorize.status, 200);
  assert.equal(authorize.headers.get("x-frame-options"), "DENY");
  assert.match(authorize.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(authorize.headers.get("referrer-policy"), "no-referrer");
  const consent = await authorize.text();
  assert.match(consent, /&lt;script&gt;not Cursor&lt;\/script&gt;/);
  assert.doesNotMatch(consent, /<script>not Cursor<\/script>/);
  assert.match(consent, /manual-code/);
  assert.match(consent, /data\.manualToken/);
  assert.match(consent, /id="status-phone" class="chip action_required"/);
  const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent)?.[1];
  assert.ok(pendingId);

  const foreignPairing = await fetch(`${base}/oauth/pairing`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://attacker.example",
    },
    body: new URLSearchParams({ pending_id: pendingId }),
  });
  assert.equal(foreignPairing.status, 403);

  await writeFile(join(configDir, "mcp-oauth.json"), JSON.stringify({
    clients: {},
    tokens: {
      empty_scope: {
        clientId: registered.client_id,
        scopes: [],
        expiresAt: Date.now() + 60_000,
        resource: `${base}/mcp`,
      },
      wrong_resource: {
        clientId: registered.client_id,
        scopes: ["mcp:tools"],
        expiresAt: Date.now() + 60_000,
        resource: "http://127.0.0.1:1/mcp",
      },
    },
  }));
  const scoped = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer empty_scope",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(scoped.status, 403);
  assert.match(scoped.headers.get("www-authenticate") ?? "", /scope="mcp:tools"/);

  const wrongResource = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer wrong_resource",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(wrongResource.status, 401);
  const invalid = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer missing",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(invalid.status, 401);
});
