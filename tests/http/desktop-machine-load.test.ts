import assert from "node:assert/strict";
import test from "node:test";
import { desktopMachineLoad } from "../../apps/mcp/src/desktop/load";

test("local Mac load reports sampled agent processes without inventing token or CPU usage", async () => {
  const sample = await desktopMachineLoad(async () => ({ codex: {
    processes: 2, cpuPercent: 14, memoryBytes: 128_000_000,
    groups: [{ name: "codex", count: 2, cpuPercent: 14, memoryBytes: 128_000_000 }],
    chats: [{ sessionId: "native-chat", processes: 1, cpuPercent: 7, memoryBytes: 64_000_000 }],
  } }), () => 1_800_000_000_000);
  assert.equal(sample.operation, "desktop.machine_load");
  assert.equal(sample.source, "process_sample");
  assert.equal(sample.observed_at, 1_800_000_000_000);
  assert.equal(sample.agents[0]?.processes, 2);
  assert.equal(sample.agents[0]?.cpu_percent, 14);
  assert.equal(sample.agents[0]?.memory_bytes, 128_000_000);
  assert.equal("tokensRecent" in sample.agents[0]!, false);
  assert.deepEqual((sample.agents[0] as unknown as { chats: unknown }).chats,
    [{ sessionId: "native-chat", processes: 1, cpuPercent: 7, memoryBytes: 64_000_000 }]);
});
