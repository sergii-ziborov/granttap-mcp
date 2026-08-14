/**
 * The published monitor must not starve the relay socket or the phone.
 *
 * Three independent defects made a healthy computer read as offline: every
 * periodic snapshot entered the durable relay mailbox, provider transcripts
 * were re-read on every request, and liveness was inferred from how long a
 * full catalog scan happened to take.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PHONE_OFFLINE_THRESHOLD_MS = 90_000;
const monitorSource = (): string =>
  readFileSync(join(process.cwd(), "apps/bridge/src/monitor.ts"), "utf8");

describe("transient snapshots", () => {
  it("lets a sender opt out of the durable mailbox", async () => {
    const { sealEnvelope } = await import(
      "../packages/core/relay-client"
    );
    const { generateKeyPair } = await import("../packages/core/crypto");
    const machine = generateKeyPair();
    const phone = generateKeyPair();
    const cfg = {
      relayUrl: "wss://relay.example/ws",
      room: "room",
      role: "machine" as const,
      deviceName: "test-mac",
      senderId: "sender",
      myPublicKey: machine.publicKey,
      mySecretKey: machine.secretKey,
      peerPublicKey: phone.publicKey,
    };
    const durable = JSON.parse(sealEnvelope(cfg, { type: "hello", role: "machine", deviceName: "d", createdAt: 1 }, "phone", {}));
    const transient = JSON.parse(sealEnvelope(cfg, { type: "hello", role: "machine", deviceName: "d", createdAt: 1 }, "phone", { reliable: false }));

    assert.equal(typeof durable.deliveryId, "string");
    assert.equal(
      transient.deliveryId,
      undefined,
      "a replaceable snapshot must not occupy the relay mailbox",
    );
  });

  it("publishes the periodic catalog transiently", () => {
    const src = monitorSource();
    assert.match(
      src,
      /client\.send\(status, "phone", \{[^}]*reliable: false/,
      "the catalog is replaced every tick and must never be queued durably",
    );
  });
});

describe("machine liveness heartbeat", () => {
  it("validates as a bounded wire payload", async () => {
    const { Payload } = await import("../packages/protocol/schema");
    const parsed = Payload.parse({
      type: "machine.heartbeat",
      machine: "mac.local",
      createdAt: 1_700_000_000_000,
    });
    assert.equal(parsed.type, "machine.heartbeat");
  });

  it("publishes transiently to the phone without scanning sessions", async () => {
    const { HEARTBEAT_INTERVAL_MS, publishHeartbeat } = await import(
      "../apps/bridge/src/monitor-heartbeat"
    );
    const sent: Array<{ payload: any; to: unknown; options: any }> = [];
    await publishHeartbeat({
      send: async (payload: any, to: unknown, options: any) => {
        sent.push({ payload, to, options });
      },
    } as never);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.payload.type, "machine.heartbeat");
    assert.equal(sent[0]!.to, "phone");
    assert.equal(sent[0]!.options.reliable, false);
    assert.ok(
      HEARTBEAT_INTERVAL_MS * 3 <= PHONE_OFFLINE_THRESHOLD_MS,
      "three heartbeats must fit inside the phone's offline threshold",
    );
  });

  it("runs on a loop of its own, never behind the catalog scan", () => {
    const src = monitorSource();
    assert.match(src, /HEARTBEAT_INTERVAL_MS/);
    const loops = src.split("startPublishLoop({").slice(1);
    const heartbeat = loops.find((body) => body.includes("HEARTBEAT_INTERVAL_MS"));
    assert.ok(heartbeat, "liveness needs its own scheduled loop");
  });
});

describe("scan pressure", () => {
  it("schedules the next scan only after the previous one finishes", async () => {
    const { startPublishLoop } = await import(
      "../apps/bridge/src/monitor-publish-loop"
    );
    const scheduled: Array<() => void> = [];
    const releases: Array<() => void> = [];
    let runs = 0;
    const stop = startPublishLoop({
      connected: () => true,
      intervalMs: 5_000,
      publish: () => {
        runs += 1;
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return { unref() {} } as NodeJS.Timeout;
      },
    });
    assert.equal(scheduled.length, 1);
    scheduled.shift()?.();
    assert.equal(runs, 1);
    assert.equal(scheduled.length, 0, "no new scan may be queued while one runs");
    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 1);
    stop();
  });

  it("keeps expensive scans single-flight and preserves a forced refresh", async () => {
    const { singleFlightPublisher } = await import(
      "../apps/bridge/src/monitor-single-flight"
    );
    const releases: Array<() => void> = [];
    const calls: boolean[] = [];
    const publish = singleFlightPublisher((forceHistory: boolean) => {
      calls.push(forceHistory);
      return new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = publish(false);
    const overlapping = publish(false);
    const refresh = publish(true);
    assert.deepEqual(calls, [false]);
    assert.equal(overlapping, first);

    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [false, true], "an explicit refresh is never dropped");
    releases.shift()?.();
    await Promise.all([first, refresh]);
  });

  it("re-reads a provider transcript only when that session moved", async () => {
    const { sessionActivityCache } = await import(
      "../apps/bridge/src/monitor-session-activity"
    );
    let reads = 0;
    const session = {
      sessionId: "chat-a",
      agent: "claude" as const,
      state: "working" as const,
      startedAt: 1,
      lastActivityAt: 100,
      tokensSession: 0,
      tokensLastTurn: 0,
    };
    const cached = sessionActivityCache((input: any) => {
      reads += 1;
      return {
        type: "session.activity" as const,
        sessionId: input.sessionId,
        agent: input.agent,
        state: input.state,
        entries: [],
        generatedAt: reads,
      };
    });

    cached(session);
    cached({ ...session });
    assert.equal(reads, 1, "an unchanged session must not re-read its transcript");
    cached({ ...session, lastActivityAt: 200 });
    assert.equal(reads, 2, "new activity must invalidate the cached transcript");
  });

  it("republishes the catalog only when a subscription actually changes", async () => {
    const { handleSubscriptionForTest } = await import("../apps/bridge/src/monitor");
    const watching = new Set<string>();
    const open = { type: "session.subscribe" as const, sessionId: "chat", active: true, createdAt: 1 };

    assert.equal(handleSubscriptionForTest(watching, open), true, "opening a chat is news");
    assert.equal(
      handleSubscriptionForTest(watching, { ...open, createdAt: 2 }),
      false,
      "the phone repeats this every few seconds; a repeat must not rescan providers",
    );
    assert.equal(
      handleSubscriptionForTest(watching, { ...open, active: false, createdAt: 3 }),
      true,
      "closing a chat is news",
    );
  });

  it("does not rescan every provider twice a minute", () => {
    const src = monitorSource();
    const interval = src.match(/const INTERVAL_MS = Number\(\s*[\s\S]*?\?\?\s*([\d_]+),/)?.[1];
    assert.ok(interval, "INTERVAL_MS must have a literal default");
    assert.ok(
      Number(interval.replace(/_/g, "")) >= 30_000,
      "a full provider scan is expensive; 5s ticks saturated the event loop",
    );
  });

  it("never drives the catalog from a fixed timer", () => {
    assert.doesNotMatch(
      monitorSource(),
      /setInterval\([^)]*publish/,
      "a fixed timer stacks overlapping scans when one runs long",
    );
  });
});
