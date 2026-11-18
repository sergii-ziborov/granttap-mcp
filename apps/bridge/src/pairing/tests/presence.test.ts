import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "granttap-presence-"));
process.env.GRANTTAP_CONFIG_DIR = dir;
const presence = await import("../presence");
const key = `${"A".repeat(42)}A=`;

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a phone stays seen while another process holds the old shared temporary name, as the ENOENT drops showed", () => {
  presence.resetPhoneSeenThrottle();
  // Another MCP server mid-write: its fixed `presence.json.tmp` is in the way (here as a folder, so any
  // write or rename through that name fails the way the monitor's did).
  mkdirSync(join(dir, "presence.json.tmp"));
  assert.equal(presence.recordPhoneSeen(1_000, key), true);
  assert.equal(presence.readControllerLastSeenAt(key), 1_000);
  assert.equal(presence.readPhoneLastSeenAt(), 1_000);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith("presence.json.tmp-")), []);
  rmSync(join(dir, "presence.json.tmp"), { recursive: true });
});

test("a phone heard from many times a second is written at most every few seconds, and a later one is", () => {
  presence.resetPhoneSeenThrottle();
  assert.equal(presence.recordPhoneSeen(10_000, key), true);
  assert.equal(presence.recordPhoneSeen(12_000, key), true);
  assert.equal(presence.readControllerLastSeenAt(key), 10_000);
  assert.equal(presence.recordPhoneSeen(15_000, key), true);
  assert.equal(presence.readControllerLastSeenAt(key), 15_000);
});

test("a presence file that cannot be written never throws into the request that reported the phone", { skip: process.getuid?.() === 0 }, () => {
  presence.resetPhoneSeenThrottle();
  chmodSync(dir, 0o500);
  try {
    assert.doesNotThrow(() => presence.recordPhoneSeen(20_000, key));
    assert.equal(presence.recordPhoneSeen(30_000, key), false);
  } finally { chmodSync(dir, 0o700); }
});
