import assert from "node:assert/strict";
import test from "node:test";
import { Payload, SignInRequest, SignInResult } from "../../../schema";

const request = {
  type: "signin.request", id: "a1b2c3d4e5f6a7b8", sessionId: "chat",
  url: "https://dash.cloudflare.com/oauth2/auth?response_type=code&state=opaque",
  service: "Cloudflare", reason: "wrangler needs an account to deploy", callbackPort: 8976,
  createdAt: 1_800_000_000_000, expiresAt: 1_800_000_300_000,
};
const result = {
  type: "signin.result", id: "a1b2c3d4e5f6a7b8", sessionId: "chat", outcome: "completed",
  callback: { path: "/oauth/callback", query: "code=opaque&state=opaque" }, createdAt: 1_800_000_010_000,
};

test("a sign-in request and its result are part of the encrypted protocol", () => {
  assert.equal(Payload.parse(request).type, "signin.request");
  assert.equal(Payload.parse(result).type, "signin.result");
  // A device-code page has no redirect to wait for, and an unattributed call has no chat.
  const { callbackPort: _port, reason: _reason, sessionId: _chat, ...bare } = request;
  assert.equal(SignInRequest.safeParse(bare).success, true);
  assert.equal(SignInResult.safeParse({ ...result, outcome: "cancelled", callback: undefined }).success, true);
  // A later phone or computer may add fields; the ones known here still read.
  assert.equal(SignInResult.safeParse({ ...result, later: true }).success, true);
});

test("only an https page can be sent to the phone for a sign-in", () => {
  for (const url of [
    "http://dash.cloudflare.com/login", "file:///etc/hosts", "javascript:alert(1)", "granttap://pair",
    "https://", "not a url", "https://user:secret@example.com/login", `https://example.com/${"a".repeat(8_200)}`,
  ]) {
    assert.equal(SignInRequest.safeParse({ ...request, url }).success, false, url.slice(0, 40));
  }
  for (const callbackPort of [0, -1, 65_536, 80.5]) {
    assert.equal(SignInRequest.safeParse({ ...request, callbackPort }).success, false, String(callbackPort));
  }
  assert.equal(SignInRequest.safeParse({ ...request, expiresAt: request.createdAt }).success, false,
    "a request that never waits is not a request");
});

test("a relayed redirect is a bounded local path and query, never another address", () => {
  const withCallback = (callback: unknown) => SignInResult.safeParse({ ...result, callback }).success;
  assert.equal(withCallback({ path: "/" }), true);
  assert.equal(withCallback({ path: "/cb", query: "" }), true);
  for (const callback of [
    { path: "oauth/callback" }, { path: "http://127.0.0.1:9/x" }, { path: "" },
    { path: "/cb?code=1" }, { path: "/cb#frag" }, { path: "/cb", query: "a=1#frag" },
    { path: "/cb with space" }, { path: "/cb\r\nHost: evil.example" }, { path: "/cb", query: "a=1\r\nX: y" },
    { path: "/cb", query: "a=é" }, { path: `/${"a".repeat(4_096)}` },
    { path: "/cb", query: "a".repeat(4_096) },
  ]) {
    assert.equal(withCallback(callback), false, JSON.stringify(callback).slice(0, 60));
  }
  assert.equal(SignInResult.safeParse({ ...result, outcome: "approved" }).success, false);
  assert.equal(SignInResult.safeParse({ ...result, id: "../../etc" }).success, false);
});

test("a message type this version does not know is refused by the schema, not thrown", () => {
  const later = Payload.safeParse({ type: "signin.later", id: "a1b2c3d4e5f6a7b8", createdAt: 1 });
  assert.equal(later.success, false);
});
