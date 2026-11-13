import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { replayLoopbackCallback } from "../callback-replay";
import { unusedLoopbackPort } from "./loopback-port";

type Seen = { method?: string; url?: string; host?: string; cookie?: string };

/** A command's own listener for the redirect, as `wrangler login` or `gh auth login` runs one. */
async function listener(
  t: TestContext,
  answer: (request: IncomingMessage) => { status: number; headers?: Record<string, string>; body?: string },
  host = "127.0.0.1",
): Promise<{ port: number; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, host: request.headers.host, cookie: request.headers.cookie });
    const { status, headers, body } = answer(request);
    response.writeHead(status, headers);
    response.end(body ?? "");
  });
  // Empty on both loopback addresses, so a replay can reach this listener and no other program's.
  const port = await unusedLoopbackPort();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port, seen, server };
}

test("the redirect is delivered once as a GET to the declared loopback port, and only its status comes back", async (t) => {
  const cli = await listener(t, () => ({ status: 200, headers: { "set-cookie": "session=secret" }, body: "<html>token=secret</html>" }));
  const outcome = await replayLoopbackCallback(cli.port, { path: "/oauth/callback", query: "code=opaque&state=xyz" });
  assert.deepEqual(outcome, { delivered: true, status: 200 }, "no body, header or cookie is handed back");
  assert.deepEqual(cli.seen, [{
    method: "GET", url: "/oauth/callback?code=opaque&state=xyz", host: `localhost:${cli.port}`, cookie: undefined,
  }]);
  const bare = await replayLoopbackCallback(cli.port, { path: "/done" });
  assert.deepEqual(bare, { delivered: true, status: 200 });
  assert.equal(cli.seen[1]?.url, "/done");
});

test("a redirect answered by the command is reported, never followed", async (t) => {
  const elsewhere = await listener(t, () => ({ status: 200 }));
  const cli = await listener(t, () => ({
    status: 302, headers: { location: `http://127.0.0.1:${elsewhere.port}/next` },
  }));
  const outcome = await replayLoopbackCallback(cli.port, { path: "/cb", query: "code=1" });
  assert.deepEqual(outcome, { delivered: true, status: 302 });
  assert.equal(elsewhere.seen.length, 0, "the next address was never asked");
});

test("a path that names another host still goes to the loopback listener", async (t) => {
  const cli = await listener(t, () => ({ status: 404 }));
  const outcome = await replayLoopbackCallback(cli.port, { path: "//evil.example/steal", query: "x=1" });
  assert.deepEqual(outcome, { delivered: true, status: 404 });
  assert.equal(cli.seen[0]?.url, "//evil.example/steal?x=1");
  assert.equal(cli.seen[0]?.host, `localhost:${cli.port}`);
});

test("anything that is not a bounded local path and query is refused before a socket opens", async (t) => {
  const cli = await listener(t, () => ({ status: 200 }));
  for (const callback of [
    { path: "cb" }, { path: "http://example.com/x" }, { path: "/cb with space" },
    { path: "/cb\r\nHost: evil.example" }, { path: "/cb", query: "a=1\r\n\r\nGET /other HTTP/1.1" },
    { path: "/cb?x=1" }, { path: `/${"a".repeat(5_000)}` },
  ]) {
    assert.deepEqual(await replayLoopbackCallback(cli.port, callback), { delivered: false, reason: "invalid" });
  }
  for (const port of [0, -1, 65_536, 80.5, Number.NaN]) {
    assert.deepEqual(await replayLoopbackCallback(port, { path: "/cb" }), { delivered: false, reason: "invalid" });
  }
  assert.equal(cli.seen.length, 0);
});

test("a command that is no longer listening, or never answers, is reported as unreachable", async (t) => {
  const gone = await listener(t, () => ({ status: 200 }));
  const port = gone.port;
  await new Promise<void>((resolve) => gone.server.close(() => resolve()));
  assert.deepEqual(await replayLoopbackCallback(port, { path: "/cb" }), { delivered: false, reason: "unreachable" });

  const silent = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => { void unusedLoopbackPort().then((port) => silent.listen(port, "127.0.0.1", resolve)); });
  t.after(() => new Promise<void>((resolve) => { silent.closeAllConnections(); silent.close(() => resolve()); }));
  const started = Date.now();
  const outcome = await replayLoopbackCallback((silent.address() as AddressInfo).port, { path: "/cb" }, 150);
  assert.deepEqual(outcome, { delivered: false, reason: "unreachable" });
  assert.ok(Date.now() - started < 2_000, "the wait is bounded");
});

test("a command that listens on the IPv6 loopback only is still reached", async (t) => {
  let cli: Awaited<ReturnType<typeof listener>>;
  try { cli = await listener(t, () => ({ status: 204 }), "::1"); }
  catch { t.skip("this host has no IPv6 loopback"); return; }
  const outcome = await replayLoopbackCallback(cli.port, { path: "/cb", query: "code=1" });
  assert.deepEqual(outcome, { delivered: true, status: 204 });
  assert.equal(cli.seen.length, 1, "delivered once, not once per address");
});
