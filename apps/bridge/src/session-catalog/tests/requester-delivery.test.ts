import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RelayClient, sealEnvelope } from "../../../../../packages/core/relay-client";
import { generateKeyPair, open, openWithTransferKey } from "../../../../../packages/core/crypto";
import type { Payload } from "../../../../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../config";
import { scanSessions } from "../../sessions";
import { handleMonitorMessage } from "../../monitor/handlers/inbound";
import { readTranscriptHistory } from "../../transcript-history";
import { rememberPublishedCatalog } from "..";

test("authenticated history and image reads return to the requesting phone only", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-requester-replica-"));
  const logs = join(root, "claude", "project");
  mkdirSync(logs, { recursive: true });
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_DIR",
    "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_CURSOR_DIR"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = join(root, "empty");
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  t.after(() => {
    for (const name of names) {
      if (before[name] == null) delete process.env[name]; else process.env[name] = before[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const picture = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
  writeFileSync(join(logs, "replica-chat.jsonl"), JSON.stringify({ type: "user", sessionId: "replica-chat",
    cwd: root, timestamp: new Date().toISOString(), message: { role: "user", content: [
      { type: "text", text: "Dedicated replica test message" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: picture } },
    ] } }) + "\n");
  saveRuntimeConfig({ meshEnabled: false,
    providerSettings: { claude: true, codex: false, cursor: false, grok: false } });
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const machine = generateKeyPair(), passive = generateKeyPair(), requester = generateKeyPair();
  const cfg = { relayUrl: `ws://127.0.0.1:${address.port}`, room: "replica-fixture", role: "machine" as const,
    deviceName: "Fixture", senderId: "machine", myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey, peerPublicKey: passive.publicKey, extraPeerPublicKeys: [requester.publicKey] };
  const frames: any[] = [];
  let socket!: import("ws").WebSocket;
  server.on("connection", value => {
    socket = value;
    value.on("message", raw => frames.push(JSON.parse(raw.toString())));
  });
  const client = new RelayClient(cfg, { autoReconnect: false });
  t.after(async () => {
    client.close();
    for (const value of server.clients) value.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const status = scanSessions();
  const session = status.sessions.find(value => value.sessionId === "replica-chat");
  assert.ok(session);
  rememberPublishedCatalog(client, { ...status, type: "sessions.status", machine: "Fixture", generatedAt: Date.now() });
  const imageId = readTranscriptHistory(session)!.entries.find(value => value.attachments?.includes("Image"))!.id;
  await client.connect();
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  const requests: Payload[] = [
    { type: "session.events", sessionId: session.sessionId, history: true, createdAt: Date.now() },
    { type: "session.image.query", sessionId: session.sessionId, requestId: "fixture-picture",
      imageId, offset: 0, createdAt: Date.now() },
  ];
  for (const request of requests) {
    frames.length = 0;
    let finish!: () => void;
    const handled = new Promise<void>(resolve => { finish = resolve; });
    const remove = client.onMessage(async (payload, peerPublicKey) => {
      const accepted = await handleMonitorMessage(client, payload, { leadership: { acquire: () => true },
        subscriptions: new Set(), publish: async () => {}, peerPublicKey });
      finish();
      return accepted;
    });
    socket.send(sealEnvelope({ ...cfg, role: "phone", senderId: "requester",
      mySecretKey: requester.secretKey, peerPublicKey: machine.publicKey }, request, "machine"));
    await handled;
    remove();
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    const replies = frames.filter(frame => frame.v === 1);
    assert.equal(replies.length, 2, "Each read grants its key and returns one encrypted result.");
    assert.equal(replies.some(frame => open(frame.nonce, frame.box, passive.publicKey, machine.secretKey)), false);
    const grant = open(replies[0].nonce, replies[0].box, requester.publicKey, machine.secretKey) as any;
    const wrapper = open(replies[1].nonce, replies[1].box, requester.publicKey, machine.secretKey) as any;
    const result = openWithTransferKey(wrapper.nonce, wrapper.box, grant.key) as any;
    if (request.type === "session.events") {
      assert.equal(result.type, "session.activity");
      assert.equal(result.history.hasMore, false);
      assert.ok(result.entries.some((entry: any) => entry.text === "Dedicated replica test message"));
    } else {
      assert.equal(result.type, "session.image.chunk");
      assert.equal(result.unavailable, undefined);
      assert.equal(result.dataBase64, picture);
    }
  }
});
