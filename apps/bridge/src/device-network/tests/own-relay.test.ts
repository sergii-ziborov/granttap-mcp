import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { OwnRelay, RELAY_SOURCE_COMMIT } from "../own-relay";

test("own relay install pins an exact revision, suppresses install scripts and keeps existing files", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-own-relay-"));
  const commands: string[][] = [];
  const relay = new OwnRelay(root, async (file, args) => {
    commands.push([file, ...args]);
    if (file === "git" && args[0] === "clone") {
      const path = args.at(-1)!;
      mkdirSync(join(path, "src/node"), { recursive: true });
      writeFileSync(join(path, "src/node/server.js"), "test source");
    }
    return args[0] === "rev-parse" ? RELAY_SOURCE_COMMIT : "";
  });
  await relay.install();
  assert.equal((await relay.status()).installed, true);
  assert.equal((await relay.status()).running, false);
  assert.equal(commands.some((row) => row.includes("--ignore-scripts")), true);
  const count = commands.length;
  await relay.install();
  assert.equal(commands.length, count);
  writeFileSync(join(root, "installation.json"), "{}" );
  await assert.rejects(relay.install(), /retained/);
  assert.equal(readFileSync(join(root, "source/src/node/server.js"), "utf8"), "test source");
});

test("own relay refuses a false checkout and never signals a stale foreign PID", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-own-relay-refuse-"));
  const relay = new OwnRelay(root, async (_file, args) => {
    if (args[0] === "clone") mkdirSync(args.at(-1)!);
    return args[0] === "rev-parse" ? "wrong commit" : "unrelated command";
  });
  await assert.rejects(relay.install(), /verified/);
  writeFileSync(join(root, "runtime.json"), JSON.stringify({ pid: process.pid }));
  await relay.stop();
  assert.equal(JSON.parse(readFileSync(join(root, "runtime.json"), "utf8")).pid, process.pid);
  await assert.rejects(relay.start(0), /port/);
  await assert.rejects(relay.start(3201), /Install/);
});

test("own relay start reports an occupied port instead of claiming a successful start", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-own-relay-port-"));
  mkdirSync(join(root, "source/src/node"), { recursive: true });
  writeFileSync(join(root, "installation.json"), JSON.stringify({ commit: RELAY_SOURCE_COMMIT }));
  writeFileSync(join(root, "source/src/node/server.js"),
    "require('node:http').createServer((q,r)=>r.end('{}')).listen(Number(process.env.PORT),'127.0.0.1');");
  const server = createServer((_request, response) => response.end('{"ok":true}'));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(new OwnRelay(root).start(port), /start|port|health/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("own relay starts a real private server, survives controller restart and stops only its process", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-own-relay-live-"));
  mkdirSync(join(root, "source/src/node"), { recursive: true });
  writeFileSync(join(root, "installation.json"), JSON.stringify({ commit: RELAY_SOURCE_COMMIT }));
  writeFileSync(join(root, "source/src/node/server.js"),
    "require('node:http').createServer((q,r)=>r.end(JSON.stringify({ok:true,instanceId:process.env.RELAY_INSTANCE_ID}))).listen(Number(process.env.PORT),'127.0.0.1');");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const relay = new OwnRelay(root);
  try {
    await relay.start(port);
    assert.equal((await new OwnRelay(root).status()).running, true);
    await relay.start(port);
    await assert.rejects(relay.start(port + 1), /Stop/);
    await new OwnRelay(root).stop();
    assert.equal((await relay.status()).running, false);
  } finally { await relay.stop(); }
});
