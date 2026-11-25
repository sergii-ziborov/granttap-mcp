import assert from "node:assert/strict";
import test from "node:test";
import type { WorkstationSnapshot } from "../../../../../../packages/protocol/schema";
import { describeWorkstation } from "../index";

const GIB = 1024 ** 3;

function snapshot(space?: WorkstationSnapshot["space"]): WorkstationSnapshot {
  return {
    load: { observedAt: 0, source: "engine", memoryTotalBytes: 24 * GIB, memoryUsedBytes: 19 * GIB,
      swapTotalBytes: 18 * GIB, swapUsedBytes: 17 * GIB, cpuPercent: 31, logicalCores: 10,
      diskTotalBytes: 926 * GIB, diskAvailableBytes: 3 * GIB,
      apps: [{ kind: "App", name: "iOS Simulator", processes: 177, memoryBytes: 4 * GIB, cpuPercent: 2.5 }] },
    ...(space ? { space } : {}),
    scanning: false, fullScanSupported: true, lowSpace: "low", settings: { automaticScan: "smart", lowSpaceAlert: true },
  };
}

test("agents read load, the largest groups and which entries must never be deleted", () => {
  const text = describeWorkstation(snapshot({ scannedAt: 0, durationMs: 31_000, complete: true, trigger: "daily",
    source: "engine", groups: [{ id: "agent:codex", title: "Codex", section: "agents", bytes: 64 * GIB,
      regenerableBytes: 3.9 * GIB, items: [
        { title: "sessions", path: "~/.codex/sessions", bytes: 19 * GIB, kind: "history" },
        { title: "tmp", path: "~/.codex/tmp", bytes: 3.9 * GIB, kind: "regenerable" }] }] }), 6 * 60_000);
  assert.match(text, /^Disk: 3\.0 GB free of 926\.0 GB \(low\)\./);
  assert.match(text, /swap 17\.0 GB of 18\.0 GB/);
  assert.match(text, /- iOS Simulator \(App, 177 processes\): 4\.0 GB/);
  assert.match(text, /Space summary 6 min old \(daily\)/);
  assert.match(text, /~\/\.codex\/sessions 19\.0 GB \[history\]/);
  assert.match(text, /never delete either\. Nothing was deleted\./);
});

test("without a summary the agent is told how to measure", () => {
  assert.match(describeWorkstation(snapshot()), /No space summary yet\. Call again with scan: true/);
});
