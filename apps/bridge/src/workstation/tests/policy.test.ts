import assert from "node:assert/strict";
import test from "node:test";
import type { WorkstationSpace } from "../../../../../packages/protocol/schema";
import {
  automaticScanReason, hostBusy, lowSpaceAlert, lowSpaceLevel, lowSpaceMessage, startWatchLoop, WATCH_INTERVAL_MS,
} from "../watch";

const GIB = 1024 ** 3;
const HOUR = 3_600_000;
const smart = { automaticScan: "smart" as const, lowSpaceAlert: true };
const started = 0;
const later = 10 * 60_000;

function space(scannedAt: number, diskAvailableBytes?: number): WorkstationSpace {
  return { scannedAt, durationMs: 1, complete: true, trigger: "daily", source: "engine",
    ...(diskAvailableBytes != null ? { diskAvailableBytes } : {}), groups: [] };
}

function conditions(availableBytes: number, busy = false, battery = false) {
  let asked = 0;
  return { value: { availableBytes, busy, onBattery: async () => { asked += 1; return battery; } }, asked: () => asked };
}

test("low space has two levels with fixed floors", () => {
  assert.equal(lowSpaceLevel(50 * GIB), "ok");
  assert.equal(lowSpaceLevel(9.9 * GIB), "low");
  assert.equal(lowSpaceLevel(2.9 * GIB), "critical");
});

test("each low-space level is told once and again only after space came back", () => {
  let state = lowSpaceAlert("ok", 8 * GIB);
  assert.deepEqual(state, { send: "low", alerted: "low" });
  assert.equal(lowSpaceAlert(state.alerted, 7 * GIB).send, undefined, "the same level is not repeated");
  state = lowSpaceAlert(state.alerted, 2 * GIB);
  assert.deepEqual(state, { send: "critical", alerted: "critical" });
  assert.equal(lowSpaceAlert("critical", 6 * GIB).send, undefined, "above critical but still low: nothing new");
  assert.deepEqual(lowSpaceAlert("critical", 9 * GIB), { alerted: "low" },
    "above 8 GB critical re-arms, and low was already said by the critical alert");
  assert.deepEqual(lowSpaceAlert("low", 2 * GIB), { send: "critical", alerted: "critical" });
  assert.deepEqual(lowSpaceAlert("low", 16 * GIB), { alerted: "ok" });
  assert.match(lowSpaceMessage("critical", 2.5 * GIB, "Mac"), /only 2\.5 GB free/);
});

test("off never measures on its own, and nothing runs while the monitor settles", async () => {
  const low = conditions(1 * GIB);
  assert.equal(await automaticScanReason({ ...smart, automaticScan: "off" }, undefined, started, low.value, later), undefined);
  assert.equal(await automaticScanReason(smart, undefined, started, low.value, 60_000), undefined);
});

test("low space measures at most hourly, and a busy computer only when space is critical", async () => {
  assert.equal(await automaticScanReason(smart, space(later - 2 * HOUR), started, conditions(8 * GIB).value, later), "low-space");
  assert.equal(await automaticScanReason(smart, space(later - HOUR / 2), started, conditions(8 * GIB).value, later), undefined);
  assert.equal(await automaticScanReason(smart, undefined, started, conditions(8 * GIB, true).value, later), undefined);
  assert.equal(await automaticScanReason(smart, undefined, started, conditions(2 * GIB, true).value, later), "low-space");
});

test("a sharp drop since the last summary measures again; a quiet day waits for a charger", async () => {
  const now = 2 * HOUR;
  assert.equal(await automaticScanReason(smart, space(now - HOUR, 80 * GIB), started, conditions(60 * GIB).value, now), "space-drop");
  assert.equal(await automaticScanReason(smart, space(now - HOUR, 80 * GIB), started, conditions(75 * GIB).value, now), undefined);
  const day = 30 * HOUR;
  const charger = conditions(200 * GIB);
  assert.equal(await automaticScanReason(smart, space(day - 25 * HOUR), started, charger.value, day), "daily");
  assert.equal(charger.asked(), 1);
  assert.equal(await automaticScanReason(smart, space(day - 25 * HOUR), started, conditions(200 * GIB, false, true).value, day), undefined);
  const recent = conditions(200 * GIB);
  assert.equal(await automaticScanReason(smart, space(day - HOUR), started, recent.value, day), undefined);
  assert.equal(recent.asked(), 0, "power is not asked about when nothing is due");
});

test("busy means a five-minute load above three quarters of the cores", () => {
  assert.equal(hostBusy(7, 10), false);
  assert.equal(hostBusy(8, 10), true);
});

test("the watch waits for the monitor to settle, then ticks every five minutes until stopped", async () => {
  const delays: number[] = [];
  let ticks = 0;
  let pending: (() => void) | undefined;
  const stop = startWatchLoop({
    tick: async () => { ticks += 1; },
    schedule: (callback, delay) => { delays.push(delay); pending = callback; return { unref() {} } as NodeJS.Timeout; },
    cancel: () => { pending = undefined; },
  });
  pending?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1);
  assert.deepEqual(delays, [3 * 60_000, WATCH_INTERVAL_MS]);
  stop();
  assert.equal(pending, undefined);
});
