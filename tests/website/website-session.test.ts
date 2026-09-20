import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { createPairing, machineConfigPath, phonePairingPath, saveConfig } from "../../apps/bridge/src/config";
import { GrantTapOAuthProvider } from "../../apps/mcp/src/oauth-provider";
import {
  phoneScanApproves,
  publishConnectError,
  publishConnectRequest,
  publishConnectRequestRetry,
  readConnectRequest,
  resetConnectWatchers,
  watchConnectDecision,
  websiteOrigin,
} from "../../apps/mcp/src/oauth/consent/website-session";

function listen(): Promise<{ origin: string; store: Map<string, Record<string, unknown>>; close: () => Promise<void> }> {
  const store = new Map<string, Record<string, unknown>>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const id = url.pathname.split("/")[4] ?? "";
    if (req.method === "PUT" && url.pathname.startsWith("/api/connect/requests/")) {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      store.set(id, { ...store.get(id), ...body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/redirect")) {
      const body = JSON.parse(await readBody(req)) as { redirectUrl?: string };
      store.set(id, { ...store.get(id), redirectUrl: body.redirectUrl });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/connect/requests/")) {
      const row = store.get(id);
      if (!row) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(row));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        store,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("website origin stays off under node:test unless explicitly set", () => {
  const previous = process.env.GRANTTAP_WEBSITE_ORIGIN;
  const skip = process.env.GRANTTAP_SKIP_WEBSITE;
  delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  delete process.env.GRANTTAP_SKIP_WEBSITE;
  assert.equal(websiteOrigin(), undefined);
  process.env.GRANTTAP_WEBSITE_ORIGIN = "https://granttap.com/";
  assert.equal(websiteOrigin(), "https://granttap.com");
  process.env.GRANTTAP_WEBSITE_ORIGIN = "";
  assert.equal(websiteOrigin(), undefined);
  if (previous == null) delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  else process.env.GRANTTAP_WEBSITE_ORIGIN = previous;
  if (skip == null) delete process.env.GRANTTAP_SKIP_WEBSITE;
  else process.env.GRANTTAP_SKIP_WEBSITE = skip;
});

test("helper publishes consent to the website and writes the Cursor redirect there", async (t) => {
  const site = await listen();
  const root = await mkdtemp(join(tmpdir(), "granttap-website-session-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_WEBSITE_ORIGIN = site.origin;
  t.after(async () => {
    resetConnectWatchers();
    await site.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const pairing = createPairing("wss://relay.example.test");
  saveConfig(machineConfigPath(), pairing.machineCfg);
  saveConfig(phonePairingPath(), pairing.phoneCfg);

  const snapshot = {
    clientName: "Cursor",
    computerName: "mac.local",
    paired: true,
    roomPrefix: "abcd1234",
    phones: [{ name: "iPhone", status: "paired" as const, lastSeenAt: null }],
    providers: [{ id: "cursor" as const, installed: true, ready: true }],
    relayStatus: "online" as const,
    mesh: { present: false, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 0 },
  };
  await publishConnectRequest(site.origin, "11111111-1111-4111-8111-111111111111", snapshot);
  const published = await readConnectRequest(site.origin, "11111111-1111-4111-8111-111111111111");
  assert.equal(published?.clientName, "Cursor");
  assert.equal(published?.paired, true);

  const provider = new GrantTapOAuthProvider("http://127.0.0.1:17342/mcp");
  const client = {
    client_id: "cursor-client",
    client_name: "Cursor",
    redirect_uris: ["http://127.0.0.1:49123/callback"],
  } as OAuthClientInformationFull;
  const params = {
    redirectUri: client.redirect_uris[0]!,
    codeChallenge: "A".repeat(43),
    scopes: ["mcp:tools"],
    state: "s",
    resource: new URL("http://127.0.0.1:17342/mcp"),
  } as AuthorizationParams;
  const pendingId = provider.createPending(client, params);
  site.store.set(pendingId, { ...snapshot, decision: "approve" });
  watchConnectDecision(site.origin, pendingId, snapshot, (approve) =>
    provider.completeConsent(pendingId, approve));
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    const row = site.store.get(pendingId);
    if (typeof row?.redirectUrl === "string") {
      const redirect = new URL(row.redirectUrl);
      assert.equal(redirect.hostname, "127.0.0.1");
      assert.ok(redirect.searchParams.get("code"));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("website never received the Cursor redirect");
});

test("a leftover seen phone does not skip /connect", async (t) => {
  const site = await listen();
  process.env.GRANTTAP_WEBSITE_ORIGIN = site.origin;
  t.after(async () => {
    resetConnectWatchers();
    await site.close();
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const pendingId = "22222222-2222-4222-8222-222222222222";
  watchConnectDecision(site.origin, pendingId, {
    clientName: "Cursor",
    computerName: "mac.local",
    paired: true,
    roomPrefix: "abcd1234",
    phones: [{ name: "iPhone", status: "seen", lastSeenAt: Date.now() }],
    providers: [],
    relayStatus: "online",
    mesh: { present: true, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 1 },
  }, () => ({ redirectUrl: "http://127.0.0.1:9/callback?code=x" }), { pollMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(site.store.get(pendingId)?.redirectUrl, undefined);
});

test("a paired Mac still opens /connect so Reconnect stays available", async (t) => {
  const site = await listen();
  const root = await mkdtemp(join(tmpdir(), "granttap-already-paired-oauth-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_WEBSITE_ORIGIN = site.origin;
  t.after(async () => {
    resetConnectWatchers();
    await site.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const pairing = createPairing("wss://relay.example.test");
  saveConfig(machineConfigPath(), pairing.machineCfg);
  saveConfig(phonePairingPath(), pairing.phoneCfg);
  const provider = new GrantTapOAuthProvider("http://127.0.0.1:17342/mcp");
  let location = "";
  const response = {
    set: () => response,
    redirect: (_status: number, target: string) => { location = target; },
  } as unknown as Response;
  const started = Date.now();
  await provider.authorize({
    client_id: "cursor-client",
    client_name: "Cursor",
    redirect_uris: ["http://127.0.0.1:49123/callback"],
  } as OAuthClientInformationFull, {
    redirectUri: "http://127.0.0.1:49123/callback",
    codeChallenge: "A".repeat(43),
    scopes: ["mcp:tools"],
    state: "s",
    resource: new URL("http://127.0.0.1:17342/mcp"),
  } as AuthorizationParams, response);
  assert.ok(Date.now() - started < 800, "authorize must not wait on the website");
  const website = new URL(location);
  assert.equal(website.pathname, "/connect");
  const pendingId = new URLSearchParams(website.hash.slice(1)).get("request");
  assert.ok(pendingId);
  const approved = provider.completeConsent(pendingId, true);
  const callback = new URL(approved.redirectUrl);
  assert.equal(callback.hostname, "127.0.0.1");
  assert.equal(callback.pathname, "/callback");
  assert.ok(callback.searchParams.get("code"));
});

test("a hung website does not leave /authorize blank", async (t) => {
  const hung = await new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer(() => { /* never answer */ });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
  const root = await mkdtemp(join(tmpdir(), "granttap-hung-website-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_WEBSITE_ORIGIN = hung.origin;
  t.after(async () => {
    resetConnectWatchers();
    await hung.close();
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const pairing = createPairing("wss://relay.example.test");
  saveConfig(machineConfigPath(), pairing.machineCfg);
  saveConfig(phonePairingPath(), pairing.phoneCfg);
  const provider = new GrantTapOAuthProvider("http://127.0.0.1:17342/mcp");
  let location = "";
  const response = {
    set: () => response,
    redirect: (_status: number, target: string) => { location = target; },
  } as unknown as Response;
  const started = Date.now();
  await provider.authorize({
    client_id: "c", client_name: "Cursor", redirect_uris: ["http://127.0.0.1:9/callback"],
  } as OAuthClientInformationFull, {
    redirectUri: "http://127.0.0.1:9/callback",
    codeChallenge: "A".repeat(43),
    scopes: ["mcp:tools"],
    resource: new URL("http://127.0.0.1:17342/mcp"),
  } as AuthorizationParams, response);
  assert.ok(Date.now() - started < 800);
  assert.equal(new URL(location).pathname, "/connect");
});

test("a failed coding-app callback is written as an error on the website", async (t) => {
  const site = await listen();
  process.env.GRANTTAP_WEBSITE_ORIGIN = site.origin;
  t.after(async () => {
    resetConnectWatchers();
    await site.close();
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const pendingId = "33333333-3333-4333-8333-333333333333";
  site.store.set(pendingId, { decision: "approve" });
  watchConnectDecision(site.origin, pendingId, {
    clientName: "Cursor",
    computerName: "mac.local",
    paired: true,
    roomPrefix: "abcd1234",
    phones: [{ name: "iPhone", status: "paired", lastSeenAt: null }],
    providers: [],
    relayStatus: "online",
    mesh: { present: false, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 0 },
  }, () => {
    throw new Error("callback failed");
  });
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    if (site.store.get(pendingId)?.error === "callback failed") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("website never received the callback error");
});

test("publishConnectRequestRetry gives up on a dead origin", async () => {
  const ok = await publishConnectRequestRetry(
    "http://127.0.0.1:1",
    "44444444-4444-4444-8444-444444444444",
    {
      clientName: "Cursor",
      computerName: "mac.local",
      paired: false,
      roomPrefix: "",
      phones: [],
      providers: [],
      relayStatus: "unknown",
      mesh: { present: false, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 0 },
    },
    2,
  );
  assert.equal(ok, false);
});

test("readConnectRequest rejects a website 500", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const origin = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await assert.rejects(
    readConnectRequest(origin, "55555555-5555-4555-8555-555555555555"),
    /request read failed \(500\)/,
  );
  await publishConnectError(origin, "55555555-5555-4555-8555-555555555555", "x".repeat(400));
});

test("only a seen phone counts as the QR-scan Approve", () => {
  assert.equal(phoneScanApproves({
    clientName: "Cursor",
    computerName: "mac.local",
    paired: true,
    roomPrefix: "abcd1234",
    phones: [{ name: "iPhone", status: "paired", lastSeenAt: null }],
    providers: [],
    relayStatus: "online",
    mesh: { present: false, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 0 },
  }), false);
  assert.equal(phoneScanApproves({
    clientName: "Cursor",
    computerName: "mac.local",
    paired: true,
    roomPrefix: "abcd1234",
    phones: [{ name: "iPhone", status: "seen", lastSeenAt: Date.now() }],
    providers: [],
    relayStatus: "online",
    mesh: { present: false, thisComputer: "mac.local", computers: ["mac.local"], openTasks: 0 },
  }), true);
});

test("authorize redirect names only the website request id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-website-redirect-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_WEBSITE_ORIGIN = "";
  t.after(() => {
    delete process.env.GRANTTAP_CONFIG_DIR;
    delete process.env.GRANTTAP_WEBSITE_ORIGIN;
  });
  const provider = new GrantTapOAuthProvider("http://127.0.0.1:17342/mcp");
  let location = "";
  const response = {
    set: () => response,
    redirect: (_status: number, target: string) => { location = target; },
  } as unknown as Response;
  await provider.authorize({
    client_id: "c", client_name: "Cursor", redirect_uris: ["http://127.0.0.1:9/callback"],
  } as OAuthClientInformationFull, {
    redirectUri: "http://127.0.0.1:9/callback",
    codeChallenge: "A".repeat(43),
    scopes: ["mcp:tools"],
    resource: new URL("http://127.0.0.1:17342/mcp"),
  } as AuthorizationParams, response);
  const website = new URL(location);
  assert.equal(website.origin, "https://granttap.com");
  assert.equal(website.pathname, "/connect");
  assert.match(website.hash, /request=/);
  assert.doesNotMatch(website.hash, /port=/);
});
