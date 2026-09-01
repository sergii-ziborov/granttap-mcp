import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessRow } from "../apps/bridge/src/machine-load/process-sampler";
import {
  attributeMcpProcesses,
  type McpServerCommand,
} from "../apps/bridge/src/machine-load/mcp-process-sampler";

const servers: McpServerCommand[] = [
  { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  { name: "filesystem", command: "node", args: ["/opt/mcp/filesystem/dist/index.js"] },
  { name: "bare", command: "/usr/local/bin/weather-mcp" },
];

function row(pid: number, command: string, cpu = 1, rssKb = 1024): ProcessRow {
  return { pid, cpuPercent: cpu, rssBytes: rssKb * 1024, command };
}

test("a server is recognised by its own argument, not by node", () => {
  const load = attributeMcpProcesses([
    row(1, "npx -y @modelcontextprotocol/server-github", 4, 50_000),
    row(2, "node /opt/mcp/filesystem/dist/index.js", 2, 30_000),
  ], servers);
  assert.equal(load.github?.processes, 1);
  assert.equal(load.github?.memoryBytes, 50_000 * 1024);
  assert.equal(load.filesystem?.cpuPercent, 2);
});

test("an unrelated node process belongs to no server", () => {
  // Every stdio server runs under node; the command alone must never be enough.
  const load = attributeMcpProcesses([
    row(1, "node /Users/me/some-other-project/server.js"),
    row(2, "npx -y something-else"),
  ], servers);
  assert.deepEqual(load, {});
});

test("a server with no arguments still owns its own binary", () => {
  const load = attributeMcpProcesses([row(1, "/usr/local/bin/weather-mcp", 3, 8_000)], servers);
  assert.equal(load.bare?.processes, 1);
  assert.equal(load.bare?.memoryBytes, 8_000 * 1024);
});

test("several processes of one server are summed", () => {
  const load = attributeMcpProcesses([
    row(1, "npx -y @modelcontextprotocol/server-github", 1.5, 10_000),
    row(2, "npx -y @modelcontextprotocol/server-github", 2.25, 20_000),
  ], servers);
  assert.equal(load.github?.processes, 2);
  assert.equal(load.github?.cpuPercent, 3.75);
  assert.equal(load.github?.memoryBytes, 30_000 * 1024);
});
