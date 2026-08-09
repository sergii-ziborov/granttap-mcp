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

function receiveRaw(client: RelayClient, envelope: Envelope): Promise<void> {
  return (client as unknown as { onRaw(raw: string): Promise<void> }).onRaw(JSON.stringify(envelope));
}

function encryptedEnvelope(
  payload: Payload,
  room: string,
  from: "machine" | "phone",
  to: "machine" | "phone" | "all",
  senderPublicKey: string,
  senderSecretKey: string,
  recipientPublicKey: string,
  deliveryId = "delivery-1",
): Envelope {
  void senderPublicKey; // documents which identity owns senderSecretKey
  const encrypted = seal(payload, recipientPublicKey, senderSecretKey);
  return {
    v: 1,
    room,
    from,
    to,
    senderId: `${from}-1`,
    deliveryId,
    nonce: encrypted.nonce,
    box: encrypted.box,
  };
}

test("relay client rejects spoofed routing and authenticated ciphertext replays", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const phoneCfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-a",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
  };
  const client = new RelayClient(phoneCfg);
  const received: Payload[] = [];
  client.onMessage((payload) => { received.push(payload); return true; });
  const payload: Payload = {
    type: "agent.event",
    text: "authenticated",
    createdAt: Date.now(),
  };
  const valid = encryptedEnvelope(
    payload,
    phoneCfg.room,
    "machine",
    "phone",
    machine.publicKey,
    machine.secretKey,
    phone.publicKey,
  );

  await receiveRaw(client, { ...valid, from: "phone" });
  await receiveRaw(client, { ...valid, to: "machine" });
  assert.equal(received.length, 0);

  await receiveRaw(client, valid);
  await receiveRaw(client, { ...valid, deliveryId: "attacker-changed-id" });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "agent.event");
});

test("relay ACK waits until one consumer actually accepts the decrypted payload", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const cfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-ack",
    role: "machine",
    deviceName: "machine",
    senderId: "machine-1",
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
  };
  const client = new RelayClient(cfg);
  const acknowledgements: string[] = [];
  (client as unknown as { ws: { readyState: number; send(raw: string): void } }).ws = {
    readyState: 1,
    send: (raw) => acknowledgements.push(raw),
  };
  const payload: Payload = {
    type: "approval.decision",
    requestId: "approval-1",
    decision: "allow",
    decidedAt: Date.now(),
  };
  const envelope = encryptedEnvelope(
    payload,
    cfg.room,
    "phone",
    "machine",
    phone.publicKey,
    phone.secretKey,
    machine.publicKey,
  );

  await receiveRaw(client, envelope);
  assert.equal(acknowledgements.length, 0);

  let accepted = 0;
  client.onMessage(() => { accepted += 1; return true; });
  await receiveRaw(client, { ...envelope, deliveryId: "retry-id" });
  assert.equal(accepted, 1);
  assert.deepEqual(JSON.parse(acknowledgements[0]!), {
    type: "relay.ack",
    deliveryId: "retry-id",
  });
});

test("per-task sealed traffic is bound to its outer task and only machine grants keys", async () => {
  const machine = generateKeyPair();
  const phone = generateKeyPair();
  const transferKey = generateTransferKey();
  const phoneCfg: PeerConfig = {
    relayUrl: "ws://127.0.0.1:1",
    room: "room-b",
    role: "phone",
    deviceName: "phone",
    senderId: "phone-1",
    myPublicKey: phone.publicKey,
    mySecretKey: phone.secretKey,
    peerPublicKey: machine.publicKey,
  };
  const phoneClient = new RelayClient(phoneCfg);
  const received: Payload[] = [];
  phoneClient.onMessage((payload) => { received.push(payload); return true; });

  const grant: Payload = {
    type: "session.key.grant",
    sessionId: "task-a",
    key: transferKey,
    createdAt: Date.now(),
  };
  await receiveRaw(phoneClient, encryptedEnvelope(
    grant,
    phoneCfg.room,
    "machine",
    "phone",
    machine.publicKey,
    machine.secretKey,
    phone.publicKey,
    "grant",
  ));
  assert.equal(phoneClient.hasSessionKey("task-a"), true);

  const mismatchedInner = sealWithTransferKey({
    type: "agent.event",
    sessionId: "task-b",
    text: "must not cross tasks",
    createdAt: Date.now(),
  } satisfies Payload, transferKey);
  const wrapper: Payload = {
    type: "session.sealed",
    sessionId: "task-a",
    nonce: mismatchedInner.nonce,
    box: mismatchedInner.box,
    createdAt: Date.now(),
  };
  await receiveRaw(phoneClient, encryptedEnvelope(
    wrapper,
    phoneCfg.room,
    "machine",
    "phone",
    machine.publicKey,
    machine.secretKey,
    phone.publicKey,
    "sealed",
  ));

  for (const [deliveryId, inner] of [
    ["sealed-missing", {
      type: "agent.event",
      text: "missing inner scope",
      createdAt: Date.now(),
    }],
    ["sealed-null", {
      type: "agent.event",
      sessionId: null,
      text: "null inner scope",
      createdAt: Date.now(),
    }],
  ] as const) {
    const sealed = sealWithTransferKey(inner, transferKey);
    await receiveRaw(phoneClient, encryptedEnvelope(
      {
        type: "session.sealed",
        sessionId: "task-a",
        nonce: sealed.nonce,
        box: sealed.box,
        createdAt: Date.now(),
      },
      phoneCfg.room,
      "machine",
      "phone",
      machine.publicKey,
      machine.secretKey,
      phone.publicKey,
      deliveryId,
    ));
  }
  assert.deepEqual(received.map((payload) => payload.type), ["session.key.grant"]);

  const matchingInner = sealWithTransferKey({
    type: "agent.event",
    sessionId: "task-a",
    text: "exact task",
    createdAt: Date.now(),
  } satisfies Payload, transferKey);
  await receiveRaw(phoneClient, encryptedEnvelope(
    {
      type: "session.sealed",
      sessionId: "task-a",
      nonce: matchingInner.nonce,
      box: matchingInner.box,
      createdAt: Date.now(),
    },
    phoneCfg.room,
    "machine",
    "phone",
    machine.publicKey,
    machine.secretKey,
    phone.publicKey,
    "sealed-matching",
  ));
  assert.deepEqual(received.map((payload) => payload.type), [
    "session.key.grant",
    "agent.event",
  ]);

  const machineCfg: PeerConfig = {
    ...phoneCfg,
    role: "machine",
    deviceName: "machine",
    senderId: "machine-1",
    myPublicKey: machine.publicKey,
    mySecretKey: machine.secretKey,
    peerPublicKey: phone.publicKey,
  };
  const machineClient = new RelayClient(machineCfg);
  await receiveRaw(machineClient, encryptedEnvelope(
    grant,
    machineCfg.room,
    "phone",
    "machine",
    phone.publicKey,
    phone.secretKey,
    machine.publicKey,
    "forged-grant",
  ));
  assert.equal(machineClient.hasSessionKey("task-a"), false);
});
