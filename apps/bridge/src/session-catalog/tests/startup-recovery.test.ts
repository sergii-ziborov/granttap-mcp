import assert from "node:assert/strict";
import test from "node:test";
import { recoverCatalogBindings } from "..";

test("cold Engine recovery starts after the first fresh catalog has reached its transport", async () => {
  let release!: () => void;
  const heldCatalog = new Promise<void>(resolve => { release = resolve; });
  const steps: string[] = [];
  const recovery = recoverCatalogBindings({
    engineAvailable: async () => true,
    publishCatalog: async () => { steps.push("catalog-start"); await heldCatalog; steps.push("catalog-sent"); },
    snapshots: async () => { steps.push("graph-read"); return ["verified-project"]; },
    recover: async snapshots => { assert.deepEqual(snapshots, ["verified-project"]); steps.push("graph-recovered"); },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { assert.deepEqual(steps, ["catalog-start"]); }
  finally { release(); await recovery; }
  assert.deepEqual(steps, ["catalog-start", "catalog-sent", "graph-read", "graph-recovered"]);
});

test("an unavailable Engine still publishes the catalog without recovering graphs", async () => {
  let published = false;
  await recoverCatalogBindings({
    engineAvailable: async () => false,
    publishCatalog: async () => { published = true; },
    snapshots: async () => { throw Error("Graph must stay idle"); },
    recover: async () => { throw Error("Graph must stay idle"); },
  });
  assert.equal(published, true);
});
