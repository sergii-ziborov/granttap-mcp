import assert from "node:assert/strict";
import test from "node:test";
import { wakePairingRoomAfterApprove } from "../apps/mcp/src/oauth/after-consent";

test("Approve wakes the pairing room; Deny leaves it alone", () => {
  const started: string[] = [];
  const start = () => {
    started.push("relay");
    return null;
  };
  wakePairingRoomAfterApprove(true, start);
  wakePairingRoomAfterApprove(false, start);
  assert.deepEqual(started, ["relay"]);
});

test("the default wake is skipped under node:test so OAuth suites can exit", () => {
  assert.equal(Boolean(process.env.NODE_TEST_CONTEXT), true);
  wakePairingRoomAfterApprove(true);
});

test("wake reports a relay that does not come online", async () => {
  const writes: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    writes.push(String(chunk));
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  }) as typeof process.stderr.write;
  try {
    wakePairingRoomAfterApprove(true, () => null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(writes.join(""), /pairing room wake did not connect/);
    writes.length = 0;
    wakePairingRoomAfterApprove(true, () => Promise.reject(new Error("relay down")));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(writes.join(""), /pairing room wake failed: relay down/);
  } finally {
    process.stderr.write = write;
  }
});
