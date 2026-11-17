import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { UnreadableFrame } from "../../../../../../packages/core/relay-inbound";
import type { Payload } from "../../../../../../packages/protocol/schema";
import { saveRuntimeConfig } from "../../../config";
import { startSessionMonitor } from "../..";
import { droppedRequestLog } from "..";

test("a dropped phone request is one line saying why, at most once a minute, then how many it stood for", () => {
  const lines: string[] = [];
  let clock = 0;
  const log = droppedRequestLog((line) => lines.push(line), () => clock);
  log.unreadable({ reason: "no-key" });
  log.unreadable({ reason: "no-key" });
  log.unreadable({ reason: "unknown", type: "session.changes.later" });
  log.unanswered("session.changes.query", new Error("relay outbound snapshot superseded by newer traffic\nstack"));
  log.unanswered("session.commit", z.object({ ok: z.boolean() }).safeParse({ ok: "the path secret.txt" }).error);
  log.unanswered("session.events", "");
  clock = 60_000;
  log.unreadable({ reason: "no-key" });
  log.unreadable({ reason: "unopenable" });
  log.unreadable({ reason: "wrong-scope", type: "session.commit" });
  assert.deepEqual(lines, [
    "[monitor] dropped a phone request: it is sealed for a chat this computer holds no key for\n",
    "[monitor] dropped a phone session.changes.later: this runtime cannot read it\n",
    "[monitor] dropped a phone session.changes.query unanswered: relay outbound snapshot superseded by newer traffic\n",
    "[monitor] dropped a phone session.commit unanswered: the answer does not fit the protocol\n",
    "[monitor] dropped a phone session.events unanswered: an unnamed error\n",
    "[monitor] dropped a phone request: it is sealed for a chat this computer holds no key for (1 more like it since the last such line)\n",
    "[monitor] dropped a phone request: its chat's key does not open it\n",
    "[monitor] dropped a phone session.commit: it names another chat than the one it is sealed for\n",
  ]);
  for (let n = 0; n < 100; n++) log.unreadable({ reason: "unknown", type: `phone.kind-${n}` });
  assert.equal(lines.length, 108, "each new kind is said once, and the remembered kinds stay bounded");
});

test("the routing monitor says which phone request it dropped and why; a monitor that does not route stays quiet", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-dropped-requests-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = root;
  saveRuntimeConfig({ meshEnabled: false, providerSettings: { claude: false, codex: false, cursor: false, grok: false } });
  let deliver: (payload: Payload, peer: string) => Promise<boolean> = async () => false;
  let unreadable: (frame: UnreadableFrame) => void = () => {};
  const client = { room: "isolated", isConnected: true, setSessionKey: () => {}, sendSession: async () => {},
    onMessage: (listener: typeof deliver) => { deliver = listener; return () => {}; },
    onUnreadable: (listener: typeof unreadable) => { unreadable = listener; return () => {}; },
    // The upload gives the answer's key grant up for newer traffic, as a backed-up queue does.
    send: async (payload: Payload) => {
      if (payload.type === "session.key.grant") throw new Error("relay outbound snapshot superseded by newer traffic");
    } };
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((line: string) => { written.push(String(line)); return true; }) as typeof write;
  const monitor = startSessionMonitor(client as never);
  t.after(async () => {
    process.stderr.write = write;
    monitor.close(); await new Promise<void>((resolve) => setImmediate(resolve));
    for (const name of names) if (prior[name] == null) delete process.env[name]; else process.env[name] = prior[name];
    rmSync(root, { recursive: true, force: true });
  });

  unreadable({ reason: "no-key" });
  const taken = await deliver({ type: "session.changes.query", sessionId: "chat-1", requestId: "r-1", createdAt: 1 }, "phone-key");
  assert.equal(taken, false, "unanswered, the request stays with the relay");
  const said = written.filter((line) => line.startsWith("[monitor] dropped"));
  assert.deepEqual(said, [
    "[monitor] dropped a phone request: it is sealed for a chat this computer holds no key for\n",
    "[monitor] dropped a phone session.changes.query unanswered: relay outbound snapshot superseded by newer traffic\n",
  ]);
  client.isConnected = false;
  unreadable({ reason: "unopenable" });
  assert.equal(written.filter((line) => line.startsWith("[monitor] dropped")).length, 2,
    "without the routing lease another monitor answers, and says so itself");
});
