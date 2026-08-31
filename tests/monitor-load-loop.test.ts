import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SessionsStatus } from "../packages/protocol/schema";

const idleStatus: SessionsStatus = {
  type: "sessions.status",
  machine: "Mac.local",
  sessions: [{
    sessionId: "codex-idle",
    agent: "codex",
    state: "idle",
    startedAt: 1,
    lastActivityAt: 2,
    tokensSession: 0,
    tokensLastTurn: 0,
  }],
  generatedAt: 10,
};

const activeStatus: SessionsStatus = {
  ...idleStatus,
  sessions: [{ ...idleStatus.sessions[0]!, state: "working" }],
  generatedAt: 20,
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Scheduled = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

function scheduler() {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    schedule(callback: () => void, delayMs: number): NodeJS.Timeout {
      const item = { callback, delayMs, cancelled: false };
      scheduled.push(item);
      return item as unknown as NodeJS.Timeout;
    },
    cancel(timer: NodeJS.Timeout): void {
      (timer as unknown as Scheduled).cancelled = true;
    },
  };
}

describe("adaptive machine-load cadence", () => {
  it("uses five seconds for activity and thirty seconds while idle", async () => {
    const {
      ACTIVE_LOAD_INTERVAL_MS,
      IDLE_LOAD_INTERVAL_MS,
      machineLoadInterval,
    } = await import("../apps/bridge/src/machine-load/loop");

    assert.equal(machineLoadInterval({ activeExecutions: 1 }, 0), ACTIVE_LOAD_INTERVAL_MS);
    assert.equal(machineLoadInterval({ activeExecutions: 0 }, 0), IDLE_LOAD_INTERVAL_MS);
    assert.equal(
      machineLoadInterval({ activeExecutions: 0, lastToolAt: 9_000 }, 10_000),
      ACTIVE_LOAD_INTERVAL_MS,
    );
    assert.equal(
      machineLoadInterval({ activeExecutions: 0, phoneForeground: true }, 10_000),
      ACTIVE_LOAD_INTERVAL_MS,
    );
  });

  it("publishes immediately when executions start or end, then adapts", async () => {
    const {
      ACTIVE_LOAD_INTERVAL_MS,
      IDLE_LOAD_INTERVAL_MS,
      startMachineLoadLoop,
    } = await import("../apps/bridge/src/machine-load/loop");
    const clock = scheduler();
    const intervals: number[] = [];
    const loop = startMachineLoadLoop({
      connected: () => true,
      publish: async (_status, intervalMs) => { intervals.push(intervalMs); },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    loop.updateStatus(idleStatus);
    await settle();
    assert.deepEqual(intervals, [IDLE_LOAD_INTERVAL_MS]);
    assert.equal(clock.scheduled.at(-1)?.delayMs, IDLE_LOAD_INTERVAL_MS);

    loop.updateStatus(activeStatus);
    await settle();
    assert.deepEqual(intervals, [IDLE_LOAD_INTERVAL_MS, ACTIVE_LOAD_INTERVAL_MS]);
    assert.equal(clock.scheduled.at(-2)?.cancelled, true);
    assert.equal(clock.scheduled.at(-1)?.delayMs, ACTIVE_LOAD_INTERVAL_MS);

    loop.updateStatus({ ...idleStatus, generatedAt: 30 });
    await settle();
    assert.deepEqual(intervals, [
      IDLE_LOAD_INTERVAL_MS,
      ACTIVE_LOAD_INTERVAL_MS,
      IDLE_LOAD_INTERVAL_MS,
    ]);
    loop.stop();
    assert.equal(clock.scheduled.at(-1)?.cancelled, true);
  });

  it("never overlaps samples and replays one transition with the latest status", async () => {
    const { startMachineLoadLoop } = await import(
      "../apps/bridge/src/machine-load/loop"
    );
    const clock = scheduler();
    const generations: number[] = [];
    let finishFirst: (() => void) | undefined;
    const loop = startMachineLoadLoop({
      connected: () => true,
      publish: (status) => {
        generations.push(status.generatedAt);
        if (generations.length > 1) return Promise.resolve();
        return new Promise<void>((resolve) => { finishFirst = resolve; });
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    loop.updateStatus(activeStatus);
    await settle();
    loop.updateStatus({ ...idleStatus, generatedAt: 40 });
    await settle();
    assert.deepEqual(generations, [20]);
    finishFirst?.();
    await settle();
    await settle();
    assert.deepEqual(generations, [20, 40]);
    loop.stop();
  });

  it("is wired beside the catalog and consumes only its cached status", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/bridge/src/monitor.ts"),
      "utf8",
    );
    assert.match(source, /startMachineLoadLoop/);
    assert.match(source, /loadLoop\.updateStatus\(status\)/);
    assert.doesNotMatch(source, /publishMachineLoad\(client, status, INTERVAL_MS\)/);
  });
});
