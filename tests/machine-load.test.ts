import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentLanes } from "../apps/bridge/src/machine-load/mcp-load-refresh";

const status = {
  type: "sessions.status" as const,
  machine: "Mac.local",
  sessions: [
    {
      sessionId: "claude-live",
      agent: "claude",
      state: "working" as const,
      startedAt: 1,
      lastActivityAt: 2,
      tokensSession: 500,
      tokensLastTurn: 20,
      contextTokensUsed: 120,
    },
  ],
  history: [
    {
      sessionId: "codex-old",
      agent: "codex",
      state: "idle" as const,
      startedAt: 1,
      lastActivityAt: 2,
      tokensSession: 300,
      tokensLastTurn: 0,
    },
  ],
  generatedAt: 5,
};

describe("machine load wire payload", () => {
  it("accepts a bounded per-agent breakdown", async () => {
    const { Payload } = await import("../packages/protocol/schema");
    const parsed = Payload.parse({
      type: "machine.load",
      machine: "Mac.local",
      monitorCpuPercent: 0.6,
      monitorMemoryBytes: 570_000_000,
      agents: [{
        agent: "claude",
        processes: 2,
        cpuPercent: 41.5,
        memoryBytes: 900_000_000,
        sessions: 37,
        scanMs: 1_200,
        tokensRecent: 800_000,
      }],
      generatedAt: 1_700_000_000_000,
    });
    assert.equal(parsed.type, "machine.load");
  });

  it("rejects an unbounded agent list", async () => {
    const { MachineLoad } = await import("../packages/protocol/schema");
    const agents = Array.from({ length: 17 }, (_, index) => ({
      agent: `agent-${index}`,
      processes: 0,
      cpuPercent: 0,
      memoryBytes: 0,
      sessions: 0,
      scanMs: 0,
      tokensRecent: 0,
    }));
    assert.throws(() => MachineLoad.parse({
      type: "machine.load",
      machine: "Mac.local",
      monitorCpuPercent: 0,
      monitorMemoryBytes: 0,
      agents,
      generatedAt: 1,
    }));
  });
});

describe("provider scan cost", () => {
  it("records the latest measured cost for each provider", async () => {
    const { providerScanCost, timedProviderScan } = await import(
      "../apps/bridge/src/machine-load/scan-cost"
    );
    const result = timedProviderScan("codex", () => ({ sessions: [1, 2], tokensRecent: 0 }));
    assert.equal(result.sessions.length, 2);
    assert.equal(providerScanCost().codex?.sessions, 2);
    assert.ok((providerScanCost().codex?.durationMs ?? -1) >= 0);
  });
});

describe("machine load assembly", () => {
  it("keeps process, scan, and token measurements independent", async () => {
    const { buildMachineLoad } = await import(
      "../apps/bridge/src/machine-load/index"
    );
    const load = buildMachineLoad({
      status,
      processes: { codex: { processes: 2, cpuPercent: 90, memoryBytes: 1_000 } },
      self: { cpuPercent: 0.6, memoryBytes: 570 },
      scanCost: { claude: { durationMs: 1_200, sessions: 1 } },
      machine: "test",
      now: 42,
    });

    assert.equal(load.agents[0]?.agent, "codex");
    assert.equal(load.agents[0]?.cpuPercent, 90);
    assert.equal(load.agents[0]?.scanMs, 0);
    const claude = load.agents.find((agent) => agent.agent === "claude");
    assert.equal(claude?.scanMs, 1_200);
    assert.equal(claude?.cpuPercent, 0);
    assert.equal(claude?.tokensRecent, 500);
    assert.equal(load.monitorCpuPercent, 0.6);
  });

  it("reports a provider that costs scan time without a running process", async () => {
    const { buildMachineLoad } = await import(
      "../apps/bridge/src/machine-load/index"
    );
    const load = buildMachineLoad({
      status: { ...status, sessions: [], history: [] },
      processes: {},
      self: { cpuPercent: 0, memoryBytes: 0 },
      scanCost: { grok: { durationMs: 8_400, sessions: 152 } },
      machine: "test",
      now: 1,
    });
    assert.equal(load.agents[0]?.agent, "grok");
    assert.equal(load.agents[0]?.scanMs, 8_400);
  });

  it("averages monitor CPU over a stable window", async () => {
    const { monitorLoadSampler } = await import(
      "../apps/bridge/src/machine-load/index"
    );
    let micros = 0;
    let clock = 0;
    let rss = 100;
    const sample = monitorLoadSampler(
      () => ({ user: micros, system: 0 }),
      () => rss,
      () => clock,
      30_000,
    );

    micros = 3_000_000;
    clock = 30_000;
    assert.equal(sample().cpuPercent, 10);
    micros = 5_000_000;
    clock = 32_000;
    rss = 200;
    assert.deepEqual(sample(), { cpuPercent: 10, memoryBytes: 200 });
    micros = 12_000_000;
    clock = 60_000;
    assert.equal(sample().cpuPercent, 30);
  });

  it("publishes a transient report the phone can decode", async () => {
    const { createMachineLoadPublisher } = await import(
      "../apps/bridge/src/machine-load/index"
    );
    const sent: Array<{ payload: unknown; ttlMs?: number; reliable?: boolean }> = [];
    const publish = createMachineLoadPublisher({
      sampleProcesses: async () => ({
        claude: { processes: 1, cpuPercent: 12, memoryBytes: 34 },
      }),
      sampleSelf: () => ({ cpuPercent: 1, memoryBytes: 2 }),
    });
    const relay = {
      async send(payload: unknown, _to: string, options: { ttlMs?: number; reliable?: boolean }) {
        sent.push({ payload, ...options });
      },
    };
    const load = await publish(relay, status, 30_000);
    assert.equal(load.type, "machine.load");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.ttlMs, 90_000);
    assert.equal(sent[0]?.reliable, false);
  });

  it("keeps process sampling single-flight during rapid catalog updates", async () => {
    const { createMachineLoadPublisher } = await import(
      "../apps/bridge/src/machine-load/index"
    );
    let release: (() => void) | undefined;
    let samples = 0;
    const publish = createMachineLoadPublisher({
      sampleProcesses: () => {
        samples += 1;
        return new Promise((resolve) => {
          release = () => resolve({});
        });
      },
      sampleSelf: () => ({ cpuPercent: 0, memoryBytes: 1 }),
    });
    const relay = { async send() {} };
    const first = publish(relay, status, 30_000);
    const overlapping = publish(relay, status, 30_000);
    assert.equal(overlapping, first);
    assert.equal(samples, 1);
    release?.();
    await first;
  });
});

describe("parallel lane counting", () => {
  const lane = (
    agent: string,
    sessionId: string,
    state: "working" | "idle",
    children: Array<"working" | "idle"> = [],
  ) => ({
    sessionId, agent, state, startedAt: 1, lastActivityAt: 2,
    tokensSession: 0, tokensLastTurn: 0,
    childThreads: children.length
      ? children.map((childState, index) => ({
          sessionId: `${sessionId}-child-${index}`,
          agent,
          state: childState,
          startedAt: 1,
          lastActivityAt: 2,
          tokensSession: 0,
          tokensLastTurn: 0,
        }))
      : undefined,
  });

  it("counts working sessions and their working sub-agents, per agent", () => {
    const lanes = agentLanes([
      lane("claude", "a", "working", ["working", "idle"]),
      lane("claude", "b", "working"),
      lane("claude", "c", "idle"),
      lane("codex", "d", "working"),
    ] as never);
    // Two working Claude sessions, one of them carrying a working sub-agent.
    assert.deepEqual(lanes, { claude: 3, codex: 1 });
  });

  it("reports nothing for a machine where no agent is working", () => {
    assert.deepEqual(agentLanes([lane("claude", "a", "idle")] as never), {});
  });
});

describe("what the phone can open", () => {
  it("carries the process list, the chats, and the disk through to the wire", async () => {
    const { buildMachineLoad, describeLoad } = await import("../apps/bridge/src/machine-load");
    const { MachineLoad } = await import("../packages/protocol/messages/machine");
    const rows = [{ pid: 1, name: "node", cpuPercent: 3, memoryBytes: 10, sessionId: "s" }];
    const load = buildMachineLoad({
      status: { type: "sessions.status", sessions: [], generatedAt: 0 } as never,
      processes: { claude: { processes: 1, cpuPercent: 3, memoryBytes: 10, groups: [], rows, chats: [{ sessionId: "s", processes: 1, cpuPercent: 3, memoryBytes: 10 }] } },
      self: { cpuPercent: 0, memoryBytes: 0 },
      scanCost: {},
      disk: { claude: { measuredAt: 1, totalBytes: 5, entries: [{ path: "~/.claude", bytes: 5 }] } },
      machine: "m", now: 2,
    });
    const claude = load.agents.find((agent) => agent.agent === "claude")!;
    assert.deepEqual(claude.processList, rows);
    assert.equal(claude.chats?.[0]?.sessionId, "s");
    assert.equal(claude.disk?.totalBytes, 5);
    assert.equal(MachineLoad.safeParse(load).success, true);
    assert.equal(describeLoad(load), "[load] claude 1 procs 3% 0 MB in 1 chats");
    assert.equal(describeLoad({ ...load, agents: [] }), "[load] no agent processes");
  });

  it("logs what it measured once in five minutes, not on every sample", async () => {
    const { createMachineLoadPublisher } = await import("../apps/bridge/src/machine-load");
    const lines: string[] = [];
    let clock = 0;
    const publish = createMachineLoadPublisher({
      sampleProcesses: async () => ({ codex: { processes: 2, cpuPercent: 1, memoryBytes: 2_000_000 } }),
      sampleSelf: () => ({ cpuPercent: 0, memoryBytes: 0 }),
      sampleDisk: (agents) => Object.fromEntries(agents.map((agent) => [agent, { measuredAt: 0, totalBytes: 1, entries: [] }])),
      log: (line) => lines.push(line),
      now: () => clock,
    });
    const client = { send: async () => {} };
    const status = { type: "sessions.status", sessions: [], generatedAt: 0 } as never;
    const first = await publish(client, status, 5_000);
    assert.equal(first.agents[0]?.disk?.totalBytes, 1);
    clock = 1_000;
    await publish(client, status, 5_000);
    clock = 5 * 60_000;
    await publish(client, status, 5_000);
    assert.deepEqual(lines, ["[load] codex 2 procs 1% 2 MB", "[load] codex 2 procs 1% 2 MB"]);
  });
});
