import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo } from "../../../packages/protocol/schema";
import { createMeshSessionCatalog } from "../../../apps/bridge/src/mesh/runtime/catalog/session-catalog";

const session = (id: string): SessionInfo => ({
  sessionId: id, agent: "codex", title: id, state: "idle",
  startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
});

test("Mesh reuses bounded history while observing new live sessions on every publish", () => {
  let historyScans = 0;
  let live = [session("first")];
  const catalog = createMeshSessionCatalog({
    history: () => { historyScans += 1; return [session("older")]; },
    live: () => live,
  });
  assert.deepEqual(catalog.sessions().map((item) => item.sessionId), ["older", "first"]);
  live = [session("second")];
  assert.deepEqual(catalog.sessions().map((item) => item.sessionId), ["older", "second"]);
  assert.equal(historyScans, 1);
  catalog.invalidateHistory();
  assert.deepEqual(catalog.sessions().map((item) => item.sessionId), ["older", "second"]);
  assert.equal(historyScans, 2);
});
