import assert from "node:assert/strict";
import test from "node:test";
import { createIdleRelease } from "../idle-release";

test("a session's relay link closes after it goes unused, so idle sessions cannot crowd out the monitor", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let released = 0, leading = false;
  const idle = createIdleRelease({ idleMs: 300_000, isLeader: () => leading, release: () => { released++; } });
  idle.touch();
  t.mock.timers.tick(299_000);
  idle.touch();
  t.mock.timers.tick(299_000);
  assert.equal(released, 0, "every use restarts the wait");
  t.mock.timers.tick(1_000);
  assert.equal(released, 1);
});

test("a process that leads the computer's monitoring keeps its link, and a cancelled wait never fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let released = 0, leading = true;
  const idle = createIdleRelease({ idleMs: 1_000, isLeader: () => leading, release: () => { released++; } });
  idle.touch();
  t.mock.timers.tick(5_000);
  assert.equal(released, 0, "without a separate monitor this process is the one the phone reaches");
  leading = false;
  t.mock.timers.tick(1_000);
  assert.equal(released, 1, "once another monitor leads, the idle link goes");
  idle.touch();
  idle.cancel();
  t.mock.timers.tick(10_000);
  assert.equal(released, 1);
});
