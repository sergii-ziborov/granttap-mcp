import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEADERSHIP_TTL_MS, monitorLeadership } from "../apps/bridge/src/monitor-leadership";

async function configured(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-leadership-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  const previousPrimary = process.env.GRANTTAP_MONITOR_PRIMARY;
  process.env.GRANTTAP_CONFIG_DIR = root;
  delete process.env.GRANTTAP_MONITOR_PRIMARY;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    if (previousPrimary == null) delete process.env.GRANTTAP_MONITOR_PRIMARY;
    else process.env.GRANTTAP_MONITOR_PRIMARY = previousPrimary;
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

test("the persistent primary replaces a per-chat publisher without killing it", async (t) => {
  const root = await configured(t);
  const lock = join(root, "monitor.lock");
  const peer = monitorLeadership();
  assert.equal(peer.acquire(), true);
  assert.match(await readFile(lock, "utf8"), /:peer$/);

  process.env.GRANTTAP_MONITOR_PRIMARY = "1";
  const primary = monitorLeadership();
  assert.equal(primary.acquire(), true);
  assert.match(await readFile(lock, "utf8"), /:primary$/);

  delete process.env.GRANTTAP_MONITOR_PRIMARY;
  assert.equal(peer.acquire(), false, "the previous owner becomes a follower on its next tick");
  process.env.GRANTTAP_MONITOR_PRIMARY = "1";
  assert.equal(primary.acquire(), true);
  primary.release();
});

test("a departed primary does not silence the next one for a whole lease", async (t) => {
  const root = await configured(t);
  const lock = join(root, "monitor.lock");
  // launchd runs one persistent monitor, so this lease belongs to a primary that
  // is gone. Its recorded id is alive -- it now belongs to an unrelated process --
  // which is exactly why liveness must not gate the takeover.
  await writeFile(lock, `${process.pid}:a-departed-primary:primary`, { mode: 0o600 });
  const unrenewed = new Date(Date.now() - LEADERSHIP_TTL_MS - 1_000);
  await utimes(lock, unrenewed, unrenewed);

  process.env.GRANTTAP_MONITOR_PRIMARY = "1";
  const messages: string[] = [];
  const primary = monitorLeadership(Date.now, (message) => messages.push(message));
  assert.equal(primary.acquire(), true, "an unrenewed lease never silences the publisher");
  assert.match(await readFile(lock, "utf8"), /:primary$/);
  assert.deepEqual(messages, [], "taking over from a departed primary is normal");
  primary.release();
});

test("the lease expires within a few publish ticks, not minutes", () => {
  // The phone waits out this window with no sessions and no load.
  assert.ok(LEADERSHIP_TTL_MS <= 120_000, `lease TTL is ${LEADERSHIP_TTL_MS}ms`);
});
