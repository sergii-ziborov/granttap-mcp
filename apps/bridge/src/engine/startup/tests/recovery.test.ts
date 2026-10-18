import assert from "node:assert/strict";
import test from "node:test";
import { startEngineRecovery } from "..";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("slow Engine installation does not hold the first catalog and shutdown prevents late recovery", async () => {
  let release!: (value: boolean) => void;
  const waiting = new Promise<boolean>(resolve => { release = resolve; });
  const events: string[] = [];
  const stop = startEngineRecovery({ prepare: () => waiting,
    available: async () => { events.push("engine"); return true; },
    recover: async () => { events.push("graph"); },
    publishCatalog: async () => { events.push("catalog"); } });
  await settled();
  assert.deepEqual(events, ["catalog"]);
  stop(); release(true); await settled();
  assert.deepEqual(events, ["catalog"]);
});

test("offline installation retries, restores graphs and recovers again after a helper restart", async () => {
  let next: (() => void) | undefined; let attempts = 0; let online = false;
  const events: string[] = [];
  const stop = startEngineRecovery({
    prepare: async () => { attempts++; if (attempts === 1) throw new Error("offline"); return true; },
    available: async () => online,
    publishCatalog: async () => { events.push("catalog"); },
    recover: async () => { events.push("graph"); },
    failed: () => { events.push("retry"); },
    schedule: callback => { next = callback; return setTimeout(() => {}, 60_000); },
  });
  try {
    await settled(); assert.deepEqual(events, ["catalog", "retry"]);
    online = true; next!(); await settled();
    assert.equal(attempts, 2); assert.deepEqual(events, ["catalog", "retry", "graph"]);
    next!(); await settled(); assert.equal(events.filter(event => event === "graph").length, 1);
    online = false; next!(); await settled();
    online = true; next!(); await settled();
    assert.equal(events.filter(event => event === "graph").length, 2);
    assert.equal(attempts, 2);
  } finally { stop(); }
});

test("disabled Engine work still publishes chats and schedules no installation retry", async () => {
  let published = false;
  const stop = startEngineRecovery({ prepare: async () => false,
    available: async () => { throw new Error("disabled"); },
    recover: async () => { throw new Error("disabled"); },
    publishCatalog: async () => { published = true; },
    schedule: () => { throw new Error("disabled"); } });
  await settled(); stop(); assert.equal(published, true);
});
