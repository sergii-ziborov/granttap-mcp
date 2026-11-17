/**
 * The phone's changes and commit requests across the whole path a real phone uses: sealed under the
 * chat's key by a phone-role client, carried by a relay, opened and routed by the monitor, answered
 * with a grant and a sealed result, and opened and checked again on the phone, while the computer's
 * upload is backed up with load reports, the way the owner's monitor was when its answers never came.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { generateKeyPair } from "../../../../../packages/core/crypto";
import { RelayClient, type PeerConfig } from "../../../../../packages/core/relay-client";
import type { MachineLoad, Payload, SessionChangesQuery, SessionChangesResult, SessionCommit, SessionCommitResult,
  SessionInfo } from "../../../../../packages/protocol/schema";
import { sessionKey } from "../../host/session-keys";
import { handleMonitorMessage } from "../../monitor/handlers/inbound";
import { rememberPublishedCatalog } from "../../session-catalog";
import { forgetWorkingTrees } from "..";

const CHAT = "5d1c7e2a-claude-desktop-chat";

/**
 * Forwards each frame to the sockets of the role it is addressed to, as the relay does, and grants
 * a 16-frame ingress window. Until `open()`, it reads nothing more from the computer: the frames the
 * computer has not handed over yet wait in its own outbound queue.
 */
async function loopbackRelay() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const roles = new Map<WebSocket, string>();
  let open = false, fromMachine = 0;
  const receipt = (socket: WebSocket, received: number) => socket.send(JSON.stringify({ type: "relay.ingress", received }));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "relay.capabilities", recipientRouting: true, ingressWindow: 16 }));
    let fromPhone = 0;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { v?: number; from?: string; to?: string };
      if (frame.v !== 1) return;
      roles.set(socket, frame.from!);
      if (frame.from === "phone") receipt(socket, ++fromPhone);
      else if (++fromMachine && open) receipt(socket, fromMachine);
      for (const [peer, role] of roles) if (peer !== socket && (frame.to === "all" || frame.to === role)) peer.send(raw.toString());
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    open: () => {
      open = true;
      for (const [socket, role] of roles) if (role === "machine") receipt(socket, fromMachine);
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function checkout(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-phone-changes-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "codex/completion-attention-20261106");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  for (const name of ["a.ts", "b.ts", "old.txt"]) writeFileSync(join(root, name), `${name}\n`);
  git("add", "."); git("commit", "-qm", "base");
  writeFileSync(join(root, "a.ts"), "edited\n"); writeFileSync(join(root, "b.ts"), "edited\n");
  rmSync(join(root, "old.txt")); writeFileSync(join(root, "new.ts"), "new\n");
  return root;
}

const load = (n: number): MachineLoad => ({ type: "machine.load", machine: "Fixture", monitorCpuPercent: n % 100,
  monitorMemoryBytes: 1_000_000 + n, agents: [], generatedAt: Date.now() });

test("a phone's changes and commit are answered across both encryption layers ahead of a backed-up upload", async (t) => {
  const root = checkout();
  const config = mkdtempSync(join(tmpdir(), "granttap-phone-changes-config-"));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = config;
  const relay = await loopbackRelay();
  const machineKeys = generateKeyPair(), phoneKeys = generateKeyPair();
  const base = { relayUrl: relay.url, room: "phone-changes-room", deviceName: "Fixture" };
  const machine = new RelayClient({ ...base, role: "machine", senderId: "machine", myPublicKey: machineKeys.publicKey,
    mySecretKey: machineKeys.secretKey, peerPublicKey: phoneKeys.publicKey } satisfies PeerConfig, { autoReconnect: false });
  const phone = new RelayClient({ ...base, role: "phone", senderId: "phone", myPublicKey: phoneKeys.publicKey,
    mySecretKey: phoneKeys.secretKey, peerPublicKey: machineKeys.publicKey } satisfies PeerConfig, { autoReconnect: false });
  let publishing = true;
  t.after(async () => {
    publishing = false;
    phone.close(); machine.close();
    await relay.close();
    forgetWorkingTrees();
    if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true });
  });

  // A Claude Desktop chat in that checkout, as the monitor last published it; both sides hold its key.
  const chat: SessionInfo = { sessionId: CHAT, agent: "claude", cwd: root, state: "idle", startedAt: 1,
    lastActivityAt: Date.now(), tokensSession: 0, tokensLastTurn: 0 };
  rememberPublishedCatalog(machine, { type: "sessions.status", machine: "Fixture", sessions: [chat], generatedAt: Date.now() });
  machine.setSessionKey(CHAT, sessionKey(CHAT));
  phone.setSessionKey(CHAT, sessionKey(CHAT));
  machine.onMessage((payload, peerPublicKey) => handleMonitorMessage(machine, payload,
    { leadership: { acquire: () => true }, subscriptions: new Set(), publish: async () => {}, peerPublicKey }));
  const received: Payload["type"][] = [];
  phone.onMessage((payload) => { received.push(payload.type); });
  await machine.connect();
  await phone.connect();

  // The computer keeps reporting load faster than its upload carries it; the oldest reports give way.
  const report = (n: number) => { void machine.send(load(n), "phone", { reliable: false, ttlMs: 60_000 }).catch(() => {}); };
  for (let n = 0; n < 2_100; n++) report(n);
  void (async () => {
    for (let n = 2_100; publishing && n < 40_000; n += 40) {
      for (let k = 0; k < 40; k++) report(n + k);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();

  // Exactly what the iPhone sends: an upper-case UUID and fractional milliseconds, under the chat's key.
  const ask = <T extends Payload>(request: SessionChangesQuery | SessionCommit, type: T["type"]) => {
    const answer = phone.waitFor((p): p is T => p.type === type && "requestId" in p && p.requestId === request.requestId, 4_000);
    void phone.sendSession(request, CHAT, "machine", { ttlMs: 60_000 });
    return answer;
  };
  const listing = ask<SessionChangesResult>({ type: "session.changes.query", sessionId: CHAT,
    requestId: "8C1F4E2A-6B3D-4F70-9A51-2E7D0C9B4A11", createdAt: Date.now() + 0.375 }, "session.changes.result");
  setTimeout(relay.open, 150);
  const listed = await listing;
  assert.equal(listed.branch, "codex/completion-attention-20261106");
  assert.deepEqual(listed.files.map((file) => `${file.status} ${file.path}`).sort(),
    [" D old.txt", " M a.ts", " M b.ts", "?? new.ts"]);
  assert.equal(listed.total, 4);
  assert.ok(received.filter((type) => type === "machine.load").length < 200,
    "the answer overtook the load reports queued before it");

  const committed = await ask<SessionCommitResult>({ type: "session.commit", sessionId: CHAT,
    requestId: "0E9A3D7C-55B2-4C8E-8F1A-7B6D2C4E9F03", message: "Commit from the phone",
    paths: listed.files.map((file) => file.path), treeToken: listed.treeToken!, createdAt: Date.now() + 0.5 },
  "session.commit.result");
  assert.equal(committed.ok, true, committed.reason);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "");
});
