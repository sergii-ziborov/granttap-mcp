import assert from "node:assert/strict";
import test from "node:test";
import { recordAttributedCall } from "../../../../../bridge/src/mesh/identity/call-scope";
import { textResult } from "../../../../../../tests/support/mcp-client";
import { waitFor } from "../../../../../../tests/support/forwarding-relay";
import { pairedSignIn, unpairedSignIn, type SignInRequestSeen } from "./support";

const SECRET_QUERY = "code=SECRET-CODE&state=SECRET-STATE";
const url = "https://dash.cloudflare.com/oauth2/auth?response_type=code&state=SECRET-STATE";

test("a chat's sign-in reaches the phone in that chat, and the browser's redirect is delivered to the command once", async (t) => {
  // The command takes its time to answer, so the repeated result arrives while the first is being delivered.
  const fixture = await pairedSignIn(t, { commandAnswersAfterMs: 300 });
  fixture.onRequest(async (request) => {
    const answer = {
      type: "signin.result" as const, id: request.id, sessionId: request.sessionId, outcome: "completed" as const,
      callback: { path: "/oauth/callback", query: SECRET_QUERY }, createdAt: Date.now(),
    };
    await fixture.phone.send(answer, "machine");
    // The person's phone, or a second phone, says it again: the command must not hear it twice.
    await fixture.phone.send({ ...answer, createdAt: Date.now() + 1 }, "machine");
  });
  const args = { url, service: "Cloudflare", callbackPort: fixture.cli.port, reason: "wrangler needs an account" };
  // The provider hook is the only one that knows which chat made the call.
  recordAttributedCall({ provider: "claude", sessionId: "claude-session", toolName: "mcp__granttap__request_sign_in", args });
  const answered = await fixture.call(args);

  assert.deepEqual(answered.structuredContent, { status: "completed", callback: "relayed", callbackStatus: 200 });
  assert.match(textResult(answered), /signed in/i);
  const request = fixture.requests[0] as SignInRequestSeen;
  assert.match(request.id, /^[a-f0-9]{24}$/);
  assert.equal(request.sessionId, "claude-session", "scoped to the calling chat, as a question is");
  assert.deepEqual(
    { url: request.url, service: request.service, reason: request.reason, callbackPort: request.callbackPort },
    { url, service: "Cloudflare", reason: "wrangler needs an account", callbackPort: fixture.cli.port },
  );
  assert.equal(request.expiresAt - request.createdAt, fixture.timeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(fixture.cli.seen, [{ method: "GET", url: `/oauth/callback?${SECRET_QUERY}` }], "once");
  // What the agent reads says that it worked, never what the redirect carried or what the command answered.
  const told = JSON.stringify(answered);
  for (const secret of ["SECRET-CODE", "SECRET-STATE", "oauth/callback", "page-with-token"]) {
    assert.equal(told.includes(secret), false, secret);
  }
});

test("a result for another request or another chat changes nothing, and the person can cancel", async (t) => {
  const fixture = await pairedSignIn(t);
  let cancel = async () => {};
  fixture.onRequest(async (request) => {
    const callback = { path: "/cb", query: SECRET_QUERY };
    await fixture.phone.send({ type: "signin.result", id: "0000000000000000", outcome: "completed", callback, createdAt: Date.now() }, "machine");
    await fixture.phone.send({ type: "signin.result", id: request.id, sessionId: "other-chat", outcome: "completed", callback, createdAt: Date.now() }, "machine");
    cancel = () => fixture.phone.send({ type: "signin.result", id: request.id, outcome: "cancelled", createdAt: Date.now() }, "machine");
  });
  const call = fixture.call({ url, service: "Cloudflare", callbackPort: fixture.cli.port });
  await waitFor(() => fixture.requests.length === 1, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fixture.cli.seen.length, 0, "neither stray result reached the command");
  await cancel();
  const answered = await call;
  assert.deepEqual(answered.structuredContent, { status: "cancelled", callback: "none", callbackStatus: null });
  assert.equal(fixture.requests[0]?.sessionId, undefined, "a call no hook attributed belongs to no chat");
  // Answered is answered: a redirect that arrives afterwards is not delivered.
  await fixture.phone.send({
    type: "signin.result", id: fixture.requests[0]!.id, outcome: "completed",
    callback: { path: "/cb", query: SECRET_QUERY }, createdAt: Date.now(),
  }, "machine");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fixture.cli.seen.length, 0);
});

test("nobody answering is a timeout, not a refusal, and a redirect that comes too late is not delivered", async (t) => {
  const fixture = await pairedSignIn(t, { timeoutMs: 300 });
  const answered = await fixture.call({ url, service: "Cloudflare", callbackPort: fixture.cli.port });
  assert.deepEqual(answered.structuredContent, { status: "timed_out", callback: "none", callbackStatus: null });
  assert.match(textResult(answered), /timeout/);
  assert.notEqual(answered.isError, true);
  await fixture.phone.send({
    type: "signin.result", id: fixture.requests[0]!.id, outcome: "completed",
    callback: { path: "/cb", query: SECRET_QUERY }, createdAt: Date.now(),
  }, "machine");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fixture.cli.seen.length, 0);
});

test("a device-code sign-in is completed by the person with nothing to deliver", async (t) => {
  const fixture = await pairedSignIn(t);
  fixture.onRequest(async (request) => {
    // No port was declared, so even a redirect the phone claims to have seen goes nowhere.
    await fixture.phone.send({
      type: "signin.result", id: request.id, outcome: "completed",
      callback: { path: "/cb", query: SECRET_QUERY }, createdAt: Date.now(),
    }, "machine");
  });
  const answered = await fixture.call({ url: "https://github.com/login/device", service: "GitHub" });
  assert.deepEqual(answered.structuredContent, { status: "completed", callback: "none", callbackStatus: null });
  assert.equal(fixture.requests[0]?.callbackPort, undefined);
  assert.equal(fixture.cli.seen.length, 0);
});

test("a redirect nothing on the computer accepts is reported as such", async (t) => {
  const fixture = await pairedSignIn(t);
  const port = fixture.cli.port;
  await fixture.cli.stop();
  fixture.onRequest(async (request) => {
    await fixture.phone.send({
      type: "signin.result", id: request.id, outcome: "completed",
      callback: { path: "/cb", query: SECRET_QUERY }, createdAt: Date.now(),
    }, "machine");
  });
  const answered = await fixture.call({ url, service: "Cloudflare", callbackPort: port });
  assert.deepEqual(answered.structuredContent, { status: "completed", callback: "unreachable", callbackStatus: null });
  assert.match(textResult(answered), new RegExp(`localhost:${port}`));
});

test("only an https page is sent to the phone, and an unpaired computer says so", async (t) => {
  const fixture = await pairedSignIn(t);
  for (const refused of ["http://dash.cloudflare.com/login", "file:///etc/hosts", "https://user:secret@example.com/"]) {
    const answer = await fixture.call({ url: refused, service: "Cloudflare" });
    assert.equal(answer.isError, true, refused);
    assert.match(textResult(answer), /https/);
    assert.equal(textResult(answer).includes("secret"), false, "the refused address is not repeated");
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fixture.requests.length, 0, "nothing was sent");

  const alone = await unpairedSignIn(t);
  const unpaired = await alone.callTool({ name: "request_sign_in", arguments: { url, service: "Cloudflare" } });
  assert.equal(unpaired.isError, true);
  assert.match(textResult(unpaired), /not paired/i);
});

test("agents are told when to ask for a sign-in on the phone and what never goes through chat", async (t) => {
  const fixture = await pairedSignIn(t);
  const tool = (await fixture.client.listTools()).tools.find((item) => item.name === "request_sign_in");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["url", "service", "callbackPort", "reason"]);
  assert.deepEqual(tool.inputSchema.required, ["url", "service"]);
  const description = tool.description ?? "";
  assert.match(description, /instead of opening a browser on this computer/);
  assert.match(description, /callbackPort/);
  assert.match(description, /http:\/\/localhost:<port>/);
  assert.match(description, /never put passwords, tokens or codes in chat/i);
  assert.equal(tool.annotations?.openWorldHint, true, "it opens a page on the internet");
  assert.equal(tool.annotations?.readOnlyHint, false);
});
