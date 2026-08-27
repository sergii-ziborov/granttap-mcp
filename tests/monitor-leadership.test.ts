import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEADERSHIP_TTL_MS, monitorLeadership } from "../apps/bridge/src/monitor-leadership";

async function configured(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-leadership-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

test("a lease held by a recycled process id is reclaimed once it goes unrenewed", async (t) => {
  const root = await configured(t);
  const lock = join(root, "monitor.lock");
  // This computer's real failure: the id belonged to the monitor when it was
  // written, and later to a long-lived HTTP service that never renews the lease.
  await writeFile(lock, `${process.pid}:someone-elses-token`, { mode: 0o600 });
  const stale = new Date(Date.now() - LEADERSHIP_TTL_MS - 60_000);
  await utimes(lock, stale, stale);

  const messages: string[] = [];
  const leadership = monitorLeadership(Date.now, (message) => messages.push(message));
  assert.equal(leadership.acquire(), true, "an unrenewed lease never blocks publishing");
  assert.match(await readFile(lock, "utf8"), new RegExp(`^${process.pid}:`));
  assert.deepEqual(messages, [], "reclaiming is normal, not something to report");
  leadership.release();
});

test("a renewed lease keeps one publisher and says why the other is silent", async (t) => {
  const root = await configured(t);
  const lock = join(root, "monitor.lock");
  const messages: string[] = [];
  let clock = Date.now();
  const leader = monitorLeadership(() => clock, (message) => messages.push(message));
  assert.equal(leader.acquire(), true);

  const follower = monitorLeadership(() => clock, (message) => messages.push(message));
  assert.equal(follower.acquire(), false, "a live, renewed lease holds");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /publishes nothing/);
  assert.match(messages[0]!, new RegExp(`held by pid ${process.pid}`));

  // The refusal is reported, then rate limited rather than repeated every tick.
  assert.equal(follower.acquire(), false);
  assert.equal(messages.length, 1);

  // Renewing keeps the lease fresh, so the follower still cannot take it.
  const before = (await stat(lock)).mtimeMs;
  clock += 1_000;
  assert.equal(leader.acquire(), true);
  assert.ok((await stat(lock)).mtimeMs >= before);

  leader.release();
  assert.equal(follower.acquire(), true, "a released lease is free immediately");
  follower.release();
});
