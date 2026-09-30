import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearCommandProcessHistory,
  commandProcessResource,
  recordCommandProcessSample,
} from "../../apps/bridge/src/machine-load/command-process/history";
import { observeCapability, toObservedCapability } from "../../apps/bridge/src/sessions/telemetry";

const START = 1_800_000_000_000;

test("GrantTap measures a command process and its children without charging the agent", (t) => {
  t.after(clearCommandProcessHistory);
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 10, agent: "codex", command: "codex", cpuTimeMs: 40_000, elapsedMs: 50_000, rssBytes: 700_000_000 },
    { pid: 20, ppid: 10, agent: "codex", command: "/opt/node /opt/npm test -- security", cpuTimeMs: 600, elapsedMs: 1_000, rssBytes: 30_000_000 },
    { pid: 21, ppid: 20, agent: "codex", command: "node test-runner", cpuTimeMs: 350, elapsedMs: 500, rssBytes: 90_000_000 },
  ], START + 1_000);
  recordCommandProcessSample([
    { pid: 10, agent: "codex", command: "codex", cpuTimeMs: 41_000, elapsedMs: 52_000, rssBytes: 700_000_000 },
    { pid: 20, ppid: 10, agent: "codex", command: "/opt/node /opt/npm test -- security", cpuTimeMs: 1_500, elapsedMs: 3_000, rssBytes: 40_000_000 },
    { pid: 21, ppid: 20, agent: "codex", command: "node test-runner", cpuTimeMs: 1_100, elapsedMs: 2_500, rssBytes: 110_000_000 },
  ], START + 3_000);
  assert.deepEqual(commandProcessResource("codex", "s", "npm test -- security", START, START + 4_000), {
    attribution: "measured", cpuTimeMs: 2_600, peakRssBytes: 150_000_000,
    processCount: 2, sampleWindowMs: 4_000,
  });
});

test("parallel identical commands are ambiguous without a session binding", (t) => {
  t.after(clearCommandProcessHistory);
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 20, agent: "claude", sessionId: "one", command: "npm test -- security", cpuTimeMs: 300, elapsedMs: 500, rssBytes: 10 },
    { pid: 30, agent: "claude", sessionId: "two", command: "npm test -- security", cpuTimeMs: 500, elapsedMs: 500, rssBytes: 20 },
  ], START + 500);
  assert.equal(commandProcessResource("claude", "unknown", "npm test -- security", START, START + 1_000), undefined);
  assert.equal(commandProcessResource("claude", "one", "npm test -- security", START, START + 1_000)?.cpuTimeMs, 300);
});

test("a shell wrapper and the command it spawned count as one process tree", (t) => {
  t.after(clearCommandProcessHistory);
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 20, agent: "claude", command: "/bin/zsh -lc 'npm test -- security'", cpuTimeMs: 100, elapsedMs: 500, rssBytes: 10 },
    { pid: 21, ppid: 20, agent: "claude", command: "npm test -- security", cpuTimeMs: 300, elapsedMs: 400, rssBytes: 20 },
  ], START + 500);
  assert.equal(commandProcessResource("claude", "one", "npm test -- security", START, START + 1_000)?.cpuTimeMs, 400);
});

test("old or unrelated processes do not become a command measurement", (t) => {
  t.after(clearCommandProcessHistory);
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 20, agent: "codex", command: "npm test -- security", cpuTimeMs: 5_000, elapsedMs: 20_000, rssBytes: 100 },
  ], START + 1_000);
  assert.equal(commandProcessResource("codex", "s", "npm test -- security", START, START + 2_000), undefined);
  assert.equal(commandProcessResource("codex", "s", "npm test -- other", START, START + 2_000), undefined);
  assert.equal(commandProcessResource("codex", "s", "pwd", START, START + 2_000), undefined);
});

test("a completed transcript call carries the OS measurement to the phone schema", (t) => {
  t.after(clearCommandProcessHistory);
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 20, agent: "codex", command: "npm test -- security", cpuTimeMs: 300,
      elapsedMs: 500, rssBytes: 8_000_000 },
  ], START + 500);
  const observation = observeCapability({
    sourceId: "s:call", sessionId: "s", toolName: "exec_command",
    input: { cmd: "npm test -- security" }, createdAt: START,
  }, { success: true }, START + 1_000, undefined, "codex");
  assert.equal(observation?.durationMs, 1_000);
  assert.equal(observation?.outcome, "success");
  assert.equal(observation?.resource?.attribution, "measured");
  assert.equal(toObservedCapability(observation!).resource?.peakRssBytes, 8_000_000);
});

test("a separate desktop reader can recover samples without storing command text", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-command-sample-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = directory;
  t.after(() => {
    clearCommandProcessHistory();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  clearCommandProcessHistory();
  recordCommandProcessSample([
    { pid: 20, agent: "codex", command: "npm test -- security", cpuTimeMs: 300,
      elapsedMs: 500, rssBytes: 8_000_000 },
  ], START + 500, true);
  const saved = readFileSync(join(directory, "command-process-samples.jsonl"), "utf8");
  assert.equal(saved.includes("npm test"), false);
  clearCommandProcessHistory();
  assert.equal(commandProcessResource("codex", "s", "npm test -- security", START, START + 1_000)?.cpuTimeMs, 300);
});
