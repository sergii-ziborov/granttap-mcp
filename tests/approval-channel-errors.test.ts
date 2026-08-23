import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PeerConfig } from "../packages/core/relay-client";
import type { Payload } from "../packages/protocol/schema";
import { requestApproval } from "../apps/bridge/src/approval";

class FailingRelay {
  setSessionKey() {}
  onMessage(_listener: (payload: Payload) => unknown) { return () => {}; }
  async send() { throw new Error("socket dropped"); }
  close() {}
}

test("approval transport failure remains an unanswered decision", async (t) => {
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = await mkdtemp(join(tmpdir(), "granttap-approval-channel-"));
  t.after(() => previous == null
    ? delete process.env.GRANTTAP_CONFIG_DIR
    : process.env.GRANTTAP_CONFIG_DIR = previous);
  const config: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1", room: "room", role: "machine",
    deviceName: "machine", senderId: "machine", myPublicKey: "unused",
    mySecretKey: "unused", peerPublicKey: "unused",
  };
  const decision = await requestApproval(config, {
    type: "approval.request", requestId: "channel-error", agent: "granttap",
    kind: "permission", tool: "write", title: "Write?", risk: "high", createdAt: Date.now(),
  }, { client: new FailingRelay() as never, timeoutMs: 100 });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.decidedBy, "unreachable");
  assert.match(decision.note ?? "", /Approval channel error/);
});
