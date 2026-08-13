import assert from "node:assert/strict";
import test from "node:test";
import {
  generateKeyPair,
  open,
  generateTransferKey,
  openWithTransferKey,
  seal,
  sealWithTransferKey,
} from "../packages/core/crypto";
import { Envelope, Payload } from "../packages/protocol/schema";
import { RelayClient, type PeerConfig } from "../packages/core/relay-client";
import { scopeCapabilityUsageToRoom } from "../apps/bridge/src/sessions";
import { commandPreviewFromInput } from "../apps/bridge/src/sessions/telemetry";
import {
  claudeToRequest,
  codexToRequest,
  decisionToClaudeOutput,
  decisionToCodexOutput,
  guessRisk,
} from "../apps/bridge/src/adapters";

test("NaCl payloads open only with the paired key", () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const stranger = generateKeyPair();
  const sealed = seal({ text: "private" }, phone.publicKey, machine.secretKey);

  assert.deepEqual(open(sealed.nonce, sealed.box, machine.publicKey, phone.secretKey), {
    text: "private",
  });
  assert.equal(open(sealed.nonce, sealed.box, stranger.publicKey, phone.secretKey), null);
});

test("pairing transfer uses an independent authenticated 256-bit key", () => {
  const key = generateTransferKey();
  const otherKey = generateTransferKey();
  const sealed = sealWithTransferKey({ room: "r1" }, key);
  assert.deepEqual(openWithTransferKey(sealed.nonce, sealed.box, key), { room: "r1" });
  assert.equal(openWithTransferKey(sealed.nonce, sealed.box, otherKey), null);
  assert.equal(openWithTransferKey(sealed.nonce, sealed.box, "not-a-key"), null);
});

test("protocol accepts correlated questions, replies, activity, and expiring envelopes", () => {
  assert.equal(Payload.safeParse({
    type: "agent.event",
    text: "Continue?",
    requestId: "q1",
    kind: "question",
    createdAt: 1,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "sessions.status",
    machine: "legacy",
    sessions: [],
    tokensAllTime: 10,
    agents: [{ agent: "claude", installed: true, hookConfigured: false }],
    generatedAt: 4,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "user.message",
    text: "yes",
    cwd: "/known/project",
    requestId: "q1",
    createdAt: 2,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "session.activity",
    sessionId: "s1",
    agent: "codex",
    state: "working",
    entries: [{ id: "e1", kind: "tool", text: "git status", createdAt: 3 }],
    generatedAt: 3,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "capability.usage.status",
    events: [{
      sourceId: "s1:3:1:mcp",
      sessionId: "s1",
      kind: "mcp",
      name: "github",
      toolName: "mcp__github__status",
      createdAt: 3,
      estimatedContextTokens: 42,
    }],
    generatedAt: 4,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "session.events",
    sessionId: "s1",
    createdAt: 5,
  }).success, true);
  assert.equal(Payload.safeParse({
    type: "sessions.refresh",
    createdAt: 6,
  }).success, true);
  assert.equal(Envelope.safeParse({
    v: 1,
    room: "r",
    from: "machine",
    to: "phone",
    senderId: "m",
    expiresAt: Date.now() + 1_000,
    nonce: "AA==",
    box: "AA==",
  }).success, true);
});

test("chat capability controls and CLI deep links stay scoped inside E2EE", () => {
  for (const payload of [
    { type: "session.skill.set", sessionId: "chat-a", skillName: "review", allowed: false, createdAt: 1 },
    { type: "session.shell.set", sessionId: "chat-a", allowed: false, createdAt: 1 },
  ]) {
    assert.equal(Payload.safeParse(payload).success, true);
  }
  assert.equal(Payload.safeParse({
    type: "session.skill.set",
    sessionId: "chat-a",
    skillName: " ",
    allowed: false,
    createdAt: 1,
  }).success, false);

  const secret = "sk-proj-never-leak-this-value";
  const commandPreview = commandPreviewFromInput({
    command: `OPENAI_API_KEY=${secret} npm test`,
  });
  assert.match(commandPreview ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(commandPreview ?? "", /never-leak/);

  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const config: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-capabilities",
    role: "machine",
    deviceName: "machine",
    senderId: "machine-1",
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
  };
  const client = new RelayClient(config);
  assert.equal(client.room, config.room);
  const scoped = scopeCapabilityUsageToRoom({
    type: "capability.usage.status",
    events: [{
      sourceId: "chat-a:shell-1",
      sessionId: "chat-a",
      kind: "cli",
      name: "shell",
      toolName: "exec_command",
      commandPreview: commandPreview!,
      createdAt: 2,
    }],
    generatedAt: 3,
  }, client.room);
  assert.deepEqual(scoped.events[0]?.deepLinkTarget, {
    kind: "chat",
    roomId: config.room,
    sessionId: "chat-a",
  });
  assert.equal(Payload.safeParse(scoped).success, true);

  const envelope = encryptedEnvelope(
    scoped,
    config.room,
    "machine",
    "phone",
    machine.publicKey,
    machine.secretKey,
    phone.publicKey,
  );
  const wire = JSON.stringify(envelope);
  assert.doesNotMatch(wire, /chat-a|npm test|commandPreview/);
  assert.deepEqual(open(envelope.nonce, envelope.box, machine.publicKey, phone.secretKey), scoped);
});

test("attachment transport budget accounts for double-sealed Cloudflare frames", () => {
  const eightMillionCharacters = "A".repeat(8_000_000);
  const base = {
    type: "user.message" as const,
    text: "attachments",
    createdAt: 1,
  };
  assert.equal(Payload.safeParse({
    ...base,
    attachments: [
      { name: "one.jpg", mimeType: "image/jpeg", data: eightMillionCharacters },
      { name: "two.jpg", mimeType: "image/jpeg", data: eightMillionCharacters },
    ],
  }).success, true);
  assert.equal(Payload.safeParse({
    ...base,
    attachments: [
      { name: "one.jpg", mimeType: "image/jpeg", data: eightMillionCharacters },
      { name: "two.jpg", mimeType: "image/jpeg", data: eightMillionCharacters },
      { name: "three.jpg", mimeType: "image/jpeg", data: "A" },
    ],
  }).success, false);
});

test("agent adapters preserve ids, classify risk, and map decisions", () => {
  assert.equal(guessRisk("Bash", "rm -rf /tmp/example"), "high");
  assert.equal(guessRisk("Read", undefined), "low");
  const claude = claudeToRequest({ tool_name: "Bash", tool_input: { command: "npm test" } });
  const codex = codexToRequest({
    tool_name: "shell",
    tool_input: { command: ["git", "status"] },
    tool_use_id: "call-1",
  });
  assert.equal(codex.requestId, "call-1");
  assert.match(claude.title, /npm test/);

  const decision = {
    type: "approval.decision" as const,
    requestId: "call-1",
    decision: "allow" as const,
    decidedAt: Date.now(),
  };
  assert.equal((decisionToClaudeOutput(decision) as any).hookSpecificOutput.permissionDecision, "allow");
  assert.equal((decisionToCodexOutput(decision) as any).hookSpecificOutput.decision.behavior, "allow");
});

function encryptedEnvelope(
  payload: Payload,
  room: string,
  from: "machine" | "phone",
  to: "machine" | "phone" | "all",
  senderPublicKey: string,
  senderSecretKey: string,
  recipientPublicKey: string,
): Envelope {
  void senderPublicKey;
  const encrypted = seal(payload, recipientPublicKey, senderSecretKey);
  return {
    v: 1,
    room,
    from,
    to,
    senderId: `${from}-1`,
    deliveryId: "delivery-1",
    nonce: encrypted.nonce,
    box: encrypted.box,
  };
}
