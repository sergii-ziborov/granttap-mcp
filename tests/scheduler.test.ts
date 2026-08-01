import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cronMatches,
  deleteSchedule,
  nextOccurrence,
  scheduledSnapshot,
  setSchedule,
} from "../apps/bridge/src/scheduler";

test("GrantTap schedules manage Codex and Claude tasks with standard cron", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-scheduler-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  const mondayNine = new Date(2026, 7, 3, 9, 0, 0).getTime();
  assert.equal(cronMatches("0 9 * * 1-5", new Date(mondayNine)), true);
  assert.equal(cronMatches("0 9 * * 1-5", new Date(2026, 7, 2, 9, 0, 0)), false);
  assert.equal(nextOccurrence("0 9 * * 1-5", mondayNine - 60_000), mondayNine);

  const base = {
    type: "schedule.set" as const,
    createdAt: Date.now(),
    task: {
      id: "morning-review",
      title: "Morning review",
      agent: "codex" as const,
      prompt: "Review the repository",
      cwd: "/repo",
      cron: "0 9 * * 1-5",
      enabled: true,
      createdAt: Date.now(),
    },
  };
  assert.equal(setSchedule(base), true);
  assert.equal(setSchedule({ ...base, task: { ...base.task, id: "claude-review", agent: "claude" } }), true);
  assert.equal(scheduledSnapshot(mondayNine - 60_000).length, 2);
  assert.equal(scheduledSnapshot(mondayNine - 60_000).every((task) => task.nextRunAt === mondayNine), true);
  assert.equal(setSchedule({ ...base, task: { ...base.task, id: "bad", cron: "not cron" } }), false);

  deleteSchedule("morning-review");
  assert.deepEqual(scheduledSnapshot().map((task) => task.id), ["claude-review"]);
});
