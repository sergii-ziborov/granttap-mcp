import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAccountLink } from "../../../../bridge/src/account-recovery/link";
import { resetConnectWatchers } from "../../oauth/consent/website-session";
import { startPasskeyAccountLink } from "../passkey";

test("verified website decision links the Mac locally without exposing the machine token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-passkey-card-"));
  const previousFetch = globalThis.fetch;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  const previousOrigin = process.env.GRANTTAP_WEBSITE_ORIGIN;
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_WEBSITE_ORIGIN = "https://granttap.com";
  t.after(async () => {
    resetConnectWatchers();
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
    if (previousOrigin === undefined) delete process.env.GRANTTAP_WEBSITE_ORIGIN;
    else process.env.GRANTTAP_WEBSITE_ORIGIN = previousOrigin;
    await rm(root, { recursive: true, force: true });
  });
  let published = false;
  let redirected = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { purpose: string };
      assert.equal(body.purpose, "account-link");
      assert.match(String(init.headers && (init.headers as Record<string, string>).authorization), /^Bearer [A-Za-z0-9_-]{43}$/);
      published = true;
      return Response.json({ ok: true });
    }
    if (init?.method === "POST" && url.endsWith("/redirect")) {
      assert.equal(JSON.parse(String(init.body)).redirectUrl, "https://granttap.com/account");
      redirected = true;
      return Response.json({ ok: true });
    }
    if (url.includes("/api/connect/requests/") && published) {
      return Response.json({ decision: "passkey",
        accountId: "11111111-1111-4111-8111-111111111111",
        machineId: "22222222-2222-4222-8222-222222222222",
        machineToken: "a".repeat(43) });
    }
    return new Response(null, { status: 404 });
  };
  const url = await startPasskeyAccountLink();
  assert.match(url, /^https:\/\/granttap\.com\/connect#request=[0-9a-f-]{36}$/);
  assert.equal(url.includes("a".repeat(43)), false);
  for (let i = 0; i < 30 && !redirected; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(loadAccountLink()?.machineId, "22222222-2222-4222-8222-222222222222");
  assert.equal(redirected, true);
});
