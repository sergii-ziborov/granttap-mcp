import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGrantTapServer } from "../../../http/create-server";
import { connectInMemory, textResult } from "../../../../../../tests/support/mcp-client";
import { createPairing, machineConfigPath, saveConfig } from "../../../../../bridge/src/config";
import { saveAccountLink } from "../../../../../bridge/src/account-recovery/link";
import { recordAccountCheck, resetAccountCheckFailures } from "../../../../../bridge/src/account-link-state";
import { resetConnectWatchers } from "../../../oauth/consent/website-session";
import { resetRelay } from "../relay";
import { resetPasskeyAccountLink } from "../../../connection-center/passkey";
import { AccountPollLease } from "../../../../../bridge/src/account-recovery/lease";
import { desktopStatusSnapshot } from "../../../status/desktop-status";

const PAGE = /^https:\/\/granttap\.com\/connect#request=[0-9a-f-]{36}$/;
const ENV = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_WEBSITE_ORIGIN", "GRANTTAP_SKIP_HOOKS", "GRANTTAP_TEST_RELAY_URL",
  "CLAUDE_CODE_SESSION_ID"] as const;

/** A private computer whose account site and relay answer from a fake fetch; nothing leaves the process. */
function computer(t: TestContext, site: { publish?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "granttap-account-first-"));
  const previous = ENV.map(key => process.env[key]);
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: root, GRANTTAP_WEBSITE_ORIGIN: "https://granttap.com",
    GRANTTAP_SKIP_HOOKS: "1", GRANTTAP_TEST_RELAY_URL: "ws://127.0.0.1:9" });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  resetAccountCheckFailures();
  t.mock.method(process.stderr, "write", () => true);
  const asked: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    asked.push(`${method} ${url.replace(/[0-9a-f-]{32,36}/g, "<id>")}`);
    if (url.includes("/api/connect/requests/") && method === "PUT") return new Response(null, { status: site.publish ?? 200 });
    if (url.startsWith("http://127.0.0.1:9/pair/")) return new Response(null, { status: 201 });
    return new Response(null, { status: 404 });
  };
  t.after(() => {
    resetConnectWatchers(); resetPasskeyAccountLink(); resetRelay();
    globalThis.fetch = previousFetch;
    ENV.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, asked };
}

const signIn = () => saveAccountLink({ accountId: "11111111-1111-4111-8111-111111111111",
  machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) });

async function tools() {
  const server = createGrantTapServer(), client = await connectInMemory(server);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, text: textResult(result), state: (result.structuredContent ?? {}) as Record<string, unknown>,
      meta: ((result._meta as { granttap?: Record<string, string> })?.granttap ?? {}) };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

test("an unpaired computer that is not signed in gets the sign-in page first and the QR as the fallback", async t => {
  const { asked } = computer(t);
  const { call, close } = await tools();
  t.after(close);
  const { state, text, meta } = await call("connect");
  assert.match(String(state.passkeyUrl), PAGE);
  assert.equal(meta.passkeyUrl, state.passkeyUrl);
  assert.equal(state.status, "pairing", "the QR waits on the card too");
  assert.match(meta.qrDataUrl ?? "", /^data:image\/png;base64,/);
  assert.deepEqual(state.accountLink, { state: "none", reason: "This computer is not signed in to a GrantTap account.",
    checkedAt: null, answeredBy: null });
  assert.equal(state.accountLinkSaved, false);
  assert.ok(text.includes(`Sign this computer in to GrantTap: give the person ${String(state.passkeyUrl)} (one use, valid 15 minutes`));
  assert.match(text, /Then: Open GrantTap on the iPhone signed in to the same account: it links this computer by itself\. If that phone is not signed in to the account, scan the one-time QR on the card instead\./);
  assert.equal(asked[0], "PUT https://granttap.com/api/connect/requests/<id>", "the sign-in page comes first");
  assert.equal(asked.filter(line => line === "PUT http://127.0.0.1:9/pair/<id>").length, 1, "then one QR");
});

test("an unpaired computer that is signed in creates nothing: the phone signed in to the same account links it", async t => {
  const { root, asked } = computer(t);
  signIn();
  recordAccountCheck("poll", { kind: "valid" });
  const { call, close } = await tools();
  t.after(close);
  const { state, text } = await call("connect");
  assert.equal(state.status, "disconnected");
  assert.equal(state.passkeyUrl, undefined);
  assert.equal(existsSync(join(root, "machine.json")), false, "no pairing is created");
  assert.deepEqual(asked, [], "no sign-in page and no QR");
  assert.equal((state.accountLink as { state: string }).state, "ok");
  assert.equal(state.accountLinkSaved, true);
  assert.match(text, /Account: signed in; a phone signed in to the same account links this computer by itself\./);
  assert.match(text, /Open GrantTap on the iPhone signed in to the same account: it links this computer by itself\. A QR is only needed if it does not: reconnect, after the person confirms, shows one on the card\./);
  const lease = new AccountPollLease("monitor");
  assert.equal(lease.claim(), true);
  t.after(() => lease.release());
  const status = await call("connection_status");
  assert.equal((status.state.accountLink as { answeredBy: string }).answeredBy, "monitor", "who answers the phone is visible");
  assert.equal(desktopStatusSnapshot().accountLink.state, "ok", "the Mac app reads the same state");
  const qr = await call("reconnect", { confirmed: true });
  assert.equal(qr.state.status, "pairing", "reconnect is the QR fallback");
});

test("a paired computer signed out by GrantTap: connect, sign_in and its old name offer one sign-in page, tools say why", async t => {
  const { asked } = computer(t);
  saveConfig(machineConfigPath(), createPairing("ws://127.0.0.1:9").machineCfg);
  signIn();
  recordAccountCheck("poll", { kind: "revoked", reason: "Machine access revoked." });
  const { call, close } = await tools();
  t.after(close);
  const status = await call("connection_status");
  assert.equal((status.state.accountLink as { state: string }).state, "revoked");
  assert.equal(status.state.accountLinkSaved, false);
  assert.match(status.text, /Account: This computer is signed out of your GrantTap account \(Machine access revoked\)\. Sign it in: call sign_in \(or run `granttap sign-in` in Terminal, or tap Sign in again on the GrantTap card\)\./);
  const connected = await call("connect");
  assert.match(String(connected.state.passkeyUrl), PAGE);
  assert.equal(connected.state.status, "paired", "a paired computer keeps its pairing; no QR");
  assert.equal(asked.some(line => line.includes("/pair/")), false);
  const signedIn = await call("sign_in");
  const alias = await call("connect_with_passkey");
  assert.equal(signedIn.state.passkeyUrl, connected.state.passkeyUrl, "one sign-in page at a time");
  assert.equal(alias.state.passkeyUrl, connected.state.passkeyUrl);
  assert.match(signedIn.text, /They confirm with their GrantTap passkey, entered only on that page\./);
  const notified = await call("notify", { message: "Build finished" });
  assert.equal(notified.result.isError, true);
  assert.match(notified.text, /^This computer is signed out of your GrantTap account/);
  recordAccountCheck("admission", { kind: "not_covered", state: "seat_limit", reason: "Every computer place is in use." });
  const uncovered = await call("ask_yes_no", { question: "Deploy?" });
  assert.match(uncovered.text, /^This computer is signed in, but not covered by your GrantTap subscription \(Every computer place is in use\)\. Every computer place on the plan is in use: turn another computer off under Managed computers \(https:\/\/granttap\.com\/account#managed-computers\)/);
});

test("a sign-in page the account service does not accept is an error that says so", async t => {
  computer(t, { publish: 503 });
  const { call, close } = await tools();
  t.after(close);
  const { result, text } = await call("sign_in");
  assert.equal(result.isError, true);
  assert.equal(text, "GrantTap could not start the sign-in. Check that granttap.com is reachable and try again.");
});
