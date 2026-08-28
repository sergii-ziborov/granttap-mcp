import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributeProcesses,
  parsePsOutput,
} from "../apps/bridge/src/machine-load/process-sampler";

describe("agent process sampling", () => {
  it("attributes only real agent executables", () => {
    const rows = [
      { pid: 1, cpuPercent: 40, rssBytes: 800, command: "/usr/local/bin/claude --resume" },
      { pid: 2, cpuPercent: 12, rssBytes: 400, command: "node /opt/homebrew/bin/codex exec" },
      { pid: 3, cpuPercent: 3, rssBytes: 100, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
      { pid: 4, cpuPercent: 99, rssBytes: 999, command: "/usr/bin/ssh not-an-agent" },
    ];
    const byAgent = attributeProcesses(rows);
    assert.equal(byAgent.claude?.processes, 1);
    assert.equal(byAgent.codex?.cpuPercent, 12);
    assert.equal(byAgent.cursor?.memoryBytes, 100);
    assert.equal(byAgent.ssh, undefined);
  });

  it("does not attribute files or search arguments that mention an agent", () => {
    assert.deepEqual(attributeProcesses([
      { pid: 9, cpuPercent: 50, rssBytes: 10, command: "vim /tmp/claude-ideas.md" },
      { pid: 10, cpuPercent: 50, rssBytes: 10, command: "rg codex /tmp/src" },
    ]), {});
  });

  it("excludes desktop chat helpers but keeps the bundled Codex CLI", () => {
    const byAgent = attributeProcesses([
      { pid: 1, cpuPercent: 47, rssBytes: 10, command: "/Users/me/.local/bin/claude -p" },
      { pid: 2, cpuPercent: 3, rssBytes: 10, command: "/Applications/Claude.app/Contents/MacOS/Claude" },
      { pid: 3, cpuPercent: 1, rssBytes: 10, command: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper" },
      { pid: 4, cpuPercent: 12, rssBytes: 10, command: "/Applications/ChatGPT.app/Contents/Resources/codex exec resume y" },
    ]);
    assert.equal(byAgent.claude?.processes, 1);
    assert.equal(byAgent.codex?.processes, 1);
  });

  it("sums several processes and parses padded ps rows", () => {
    const summed = attributeProcesses([
      { pid: 1, cpuPercent: 10.5, rssBytes: 100, command: "/usr/local/bin/grok" },
      { pid: 2, cpuPercent: 4.5, rssBytes: 200, command: "/usr/local/bin/grok --print" },
    ]);
    assert.deepEqual(summed.grok, { processes: 2, cpuPercent: 15, memoryBytes: 300 });

    const rows = parsePsOutput([
      "  PID  %CPU      RSS COMMAND",
      "  412  41.5  1048576 /usr/local/bin/claude --resume abc",
      " 1099   0.0     2048 /usr/bin/login -pf serhii",
    ].join("\n"));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      pid: 412,
      cpuPercent: 41.5,
      rssBytes: 1_048_576 * 1024,
      command: "/usr/local/bin/claude --resume abc",
    });
  });
});
