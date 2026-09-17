import assert from "node:assert/strict";
import test from "node:test";
import { watchMailboxClaim } from "../apps/mcp/src/oauth/mailbox-claim";

test("mailbox claim fires only after an occupied mailbox is consumed", async () => {
  const peeks: string[] = ["occupied", "occupied", "empty"];
  let claimed = 0;
  const scheduled: Array<() => void> = [];
  const stop = watchMailboxClaim(
    "https://relay.example.test",
    "ab".repeat(16),
    Date.now() + 60_000,
    () => { claimed += 1; },
    {
      peek: async () => peeks.shift() as "occupied" | "empty" | "unsupported",
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    },
  );
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(claimed, 0);
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(claimed, 0);
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(claimed, 1);
  stop();
});

test("an empty mailbox that was never occupied is expiry, not a scan", async () => {
  let claimed = 0;
  const scheduled: Array<() => void> = [];
  watchMailboxClaim(
    "https://relay.example.test",
    "cd".repeat(16),
    Date.now() + 60_000,
    () => { claimed += 1; },
    {
      peek: async () => "empty",
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    },
  );
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(claimed, 0);
});

test("an old relay without HEAD stops watching instead of treating 405 as a scan", async () => {
  let claimed = 0;
  const scheduled: Array<() => void> = [];
  watchMailboxClaim(
    "https://relay.example.test",
    "ef".repeat(16),
    Date.now() + 60_000,
    () => { claimed += 1; },
    {
      peek: async () => "unsupported",
      schedule: (callback) => {
        scheduled.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    },
  );
  scheduled.shift()?.();
  await Promise.resolve();
  assert.equal(claimed, 0);
  assert.equal(scheduled.length, 0);
});
