import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionKey, sessionKeysPath } from "../apps/bridge/src/session-keys";
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
