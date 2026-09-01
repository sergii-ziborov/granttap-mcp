import assert from "node:assert/strict";
import test from "node:test";
import {
  attributedMcpResource,
  clearMcpLoad,
  recordMcpLoad,
} from "../apps/bridge/src/machine-load/mcp-load-cache";
import { configuredMcpCommands } from "../apps/bridge/src/machine-load/mcp-load-refresh";
import type { SessionInfo } from "../packages/protocol/schema";

const load = { github: { processes: 2, cpuPercent: 3, memoryBytes: 40_000_000 } };

test("a finished call reports what its server was costing around then", (t) => {
  t.after(clearMcpLoad);
  const now = 1_800_000_000_000;
  recordMcpLoad(load, now);
  const resource = attributedMcpResource("github", now - 5_000, now);
  assert.equal(resource?.attribution, "attributed");
  assert.equal(resource?.peakRssBytes, 40_000_000);
  assert.equal(resource?.processCount, 2);
});

test("a sample that cannot speak for the moment reports nothing", (t) => {
  t.after(clearMcpLoad);
  const now = 1_800_000_000_000;
  recordMcpLoad(load, now);
  // A call from long before this sample gets nothing rather than a wrong number.
  assert.equal(attributedMcpResource("github", now - 600_000, now), undefined);
  // A sample too old to describe the present is equally useless.
  assert.equal(attributedMcpResource("github", now, now + 600_000), undefined);
  // A server nobody sampled has nothing to report.
  assert.equal(attributedMcpResource("filesystem", now, now), undefined);
});

test("nothing sampled at all reports nothing", () => {
  clearMcpLoad();
  assert.equal(attributedMcpResource("github", 1, 1), undefined);
});

test("stdio servers are collected once across sessions", (t) => {
  const previous = process.env.GRANTTAP_CLAUDE_MCP_CONFIG;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_MCP_CONFIG;
    else process.env.GRANTTAP_CLAUDE_MCP_CONFIG = previous;
  });
  // Two sessions in one repository must not yield the same server twice.
  const session = { sessionId: "a", agent: "claude", cwd: "/nowhere-at-all" } as SessionInfo;
  const commands = configuredMcpCommands([session, { ...session, sessionId: "b" }]);
  assert.equal(new Set(commands.map((item) => item.name)).size, commands.length);
});
