import assert from "node:assert/strict";
import test from "node:test";
import { RelayLinkWatch } from "../../packages/core/socket-lifecycle/link-watch";

test("a computer that keeps being refused or dropped is reported once, with the relay's last reason", () => {
  let now = 0;
  const stuck: { failures: number; reason: string }[] = [];
  const watch = new RelayLinkWatch({ now: () => now, onStuck: report => stuck.push(report) });
  for (let attempt = 0; attempt < 5; attempt++) { now += 15_000; watch.failed("429 device-connections"); }
  assert.equal(stuck.length, 0, "five failures in a row are still an ordinary reconnect");
  now += 15_000; watch.failed("429 device-connections");
  assert.deepEqual(stuck, [{ failures: 6, reason: "429 device-connections" }]);
  for (let attempt = 0; attempt < 6; attempt++) { now += 15_000; watch.failed("429 device-connections"); }
  assert.equal(stuck.length, 1, "it is reported once per ten minutes, not on every retry");
  now += 10 * 60_000; watch.failed("1009 oversize");
  assert.equal(stuck.length, 1, "after a quiet spell one failure is a reconnect again");
  for (let attempt = 0; attempt < 5; attempt++) { now += 15_000; watch.failed("1009 oversize"); }
  assert.equal(stuck.at(-1)?.reason, "1009 oversize");
});

test("a link that holds, or a short drop now and then, is not a stuck computer", () => {
  let now = 0;
  const stuck: unknown[] = [];
  const watch = new RelayLinkWatch({ now: () => now, onStuck: report => stuck.push(report) });
  for (let attempt = 0; attempt < 8; attempt++) {
    now += 10_000; watch.opened();
    now += 5_000; watch.closed(1006, "");
  }
  assert.equal(stuck.length, 1, "sockets that close within seconds count as failures");
  const steady = new RelayLinkWatch({ now: () => now, onStuck: report => stuck.push(report) });
  for (let attempt = 0; attempt < 8; attempt++) {
    now += 10_000; steady.opened();
    now += 90_000; steady.closed(1006, "");
  }
  assert.equal(stuck.length, 1, "a link that held for a minute resets the count");
  now += 6 * 60_000; steady.failed("timeout");
  assert.equal(stuck.length, 1, "old failures age out of the five-minute window");
});
