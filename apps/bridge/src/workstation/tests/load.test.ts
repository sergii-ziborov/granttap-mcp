import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { EngineRemoteError, type EngineWorkstationLoad } from "../../engine/protocol/engine-protocol";
import type { EngineClientLike } from "../../engine/runtime/engine-supervisor";
import { workstationEngine } from "../engine";
import { hostLoad, parseSwapUsage } from "../load";

const enabled = { GRANTTAP_ENGINE_ENABLED: "1" } as NodeJS.ProcessEnv;

function engineLoad(): EngineWorkstationLoad {
  return {
    captured_at_ms: 5, memory_total_bytes: 24, memory_used_bytes: 19, memory_available_bytes: 5,
    swap_total_bytes: 18, swap_used_bytes: 17, cpu_percent_tenths: 1_234, logical_cores: 10, physical_cores: 10,
    volumes: [{ mount: "/", total_bytes: 900, available_bytes: 7, home: true }],
    sessions: [{ kind: "App", name: "iOS Simulator", processes: 177, rss_bytes: 4, cpu_percent_tenths: 25,
      project: "/Users/me/dev/app" }, { kind: "Build", name: null, processes: 3, rss_bytes: 1, cpu_percent_tenths: 0 }],
  };
}

test("swap usage is read from sysctl's sentence", () => {
  assert.deepEqual(parseSwapUsage("total = 18432.00M  used = 17612.25M  free = 819.75M  (encrypted)"),
    { total: 18432 * 1024 ** 2, used: Math.round(17612.25 * 1024 ** 2) });
  assert.equal(parseSwapUsage("vm.swapusage: unavailable"), undefined);
});

test("the Engine's sample becomes the phone's load with the home volume and named apps", async () => {
  const load = await hostLoad(engineLoad(), 0, "/Users/me");
  assert.equal(load.source, "engine");
  assert.equal(load.cpuPercent, 100, "summed core time never shows above the whole computer");
  assert.equal(load.diskAvailableBytes, 7);
  assert.deepEqual(load.apps[0], { kind: "App", name: "iOS Simulator", processes: 177, memoryBytes: 4,
    cpuPercent: 2.5, project: "~/dev/app" });
  assert.equal(load.apps[1]!.name, undefined);
});

test("without the Engine the operating system still answers", async () => {
  const load = await hostLoad(undefined, 42, tmpdir());
  assert.equal(load.source, "basic");
  assert.equal(load.observedAt, 42);
  assert.ok(load.memoryTotalBytes > 0 && load.logicalCores >= 1 && load.diskTotalBytes > 0);
  assert.deepEqual(load.apps, []);
});

function client(answer: () => Promise<unknown>, closed: { count: number }): EngineClientLike {
  return { request: answer as EngineClientLike["request"], close: () => { closed.count += 1; } };
}

test("an Engine without workstation operations is not asked again for ten minutes", async () => {
  let clock = 0;
  let asked = 0;
  const closed = { count: 0 };
  const engine = workstationEngine({ env: enabled, now: () => clock, connect: () => client(async () => {
    asked += 1;
    throw new EngineRemoteError("INVALID_REQUEST", "unknown variant `workstation.load`");
  }, closed) });
  assert.equal(engine.supported(), true);
  assert.equal(await engine.load(), undefined);
  assert.equal(engine.supported(), false);
  assert.equal(await engine.space(5_000), "unsupported");
  assert.equal(asked, 1);
  clock = 11 * 60_000;
  assert.equal(await engine.space(5_000), "unsupported");
  assert.equal(asked, 2, "asked again after ten minutes");
});

test("each space summary takes its own connection and closes it; busy is told apart", async () => {
  const closed = { count: 0 };
  let connections = 0;
  const engine = workstationEngine({ env: enabled, connect: () => {
    connections += 1;
    return client(async () => { throw new EngineRemoteError("WORKSTATION_SPACE_BUSY", "busy"); }, closed);
  } });
  assert.equal(await engine.space(5_000), "busy");
  assert.equal(await engine.space(5_000), "busy");
  assert.equal(connections, 2);
  assert.equal(closed.count, 2);
  assert.equal(engine.supported(), true);
});

test("a disabled Engine is never connected to", async () => {
  const engine = workstationEngine({ env: {} as NodeJS.ProcessEnv, connect: () => { throw new Error("connected"); } });
  assert.equal(await engine.load(), undefined);
  assert.equal(await engine.space(5_000), "unavailable");
  assert.equal(engine.supported(), false);
});
