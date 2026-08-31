import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  sendProjectPayload,
  sessionKey,
  sessionKeysPath,
} from "../apps/bridge/src/session-keys";
import type { Payload } from "../packages/protocol/schema";
import { openWithTransferKey, sealWithTransferKey } from "../packages/core/crypto";

test("each task has an independent key and one task key cannot open another", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-task-keys-"));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => {
    if (before == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = before;
  });

  const first = sessionKey("task-a");
  const second = sessionKey("task-b");
  assert.notEqual(first, second);
  assert.equal(sessionKey("task-a"), first, "a task key must persist for reconnects");

  const ciphertext = sealWithTransferKey({ sessionId: "task-b", text: "private" }, second);
  assert.equal(openWithTransferKey(ciphertext.nonce, ciphertext.box, first), null);
  assert.deepEqual(openWithTransferKey(ciphertext.nonce, ciphertext.box, second), {
    sessionId: "task-b", text: "private",
  });

  assert.equal((await stat(sessionKeysPath())).mode & 0o777, 0o600);
});

test("Project records use an independent Project key and declare its grant purpose", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-project-keys-"));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => {
    if (before == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = before;
  });
  const sent: Payload[] = [];
  const sealed: Array<{ payload: Payload; sessionId: string }> = [];
  const keys = new Map<string, string>();
  const client = {
    setSessionKey: (sessionId: string, key: string) => keys.set(sessionId, key),
    send: async (payload: Payload) => { sent.push(payload); },
    sendSession: async (payload: Payload, sessionId: string) => {
      sealed.push({ payload, sessionId });
    },
  };
  await sendProjectPayload(client as never, {
    type: "project.policy.ack", sessionId: "project", projectId: "project",
    acknowledgement: {
      projectId: "project", policyRevision: 1, endpointId: "mac", provider: "claude",
      capabilities: [], observedAt: 1,
    },
  });
  assert.equal(keys.has("project"), true);
  assert.equal(sent[0]?.type, "session.key.grant");
  assert.equal(sent[0]?.type === "session.key.grant" && sent[0].purpose, "project");
  assert.equal(sealed[0]?.sessionId, "project");
  assert.equal(sealed[0]?.payload.type, "project.policy.ack");
});
