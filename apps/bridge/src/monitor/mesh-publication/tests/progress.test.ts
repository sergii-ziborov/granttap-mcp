import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRuntimeConfig } from "../../../config";
import { localMeshStore, resetLocalMeshStore } from "../../../mesh/local-remote/local";
import { startSessionMonitor } from "../..";
import type { Payload } from "../../../../../../packages/protocol/schema";

test("a stalled Mesh delivery cannot hold the next current chat catalog", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-mesh-progress-"));
  const names = ["GRANTTAP_CONFIG_DIR", "GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR",
    "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_GROK_SESSIONS_DIR", "GRANTTAP_CURSOR_TRANSCRIPTS_DIR",
    "GRANTTAP_ENGINE_ENABLED"];
  const prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) process.env[n] = root;
  process.env.GRANTTAP_ENGINE_ENABLED = "0";
  resetLocalMeshStore();
  saveRuntimeConfig({ meshEnabled: true, providerSettings: { claude: false, codex: false, cursor: false, grok: false } });
  localMeshStore().upsertProject({ projectId: "slow-mesh", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 });
  const catalogs: Payload[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let enteredMesh!: () => void;
  const meshDelivery = new Promise<void>(resolve => { enteredMesh = resolve; });
  const client = { room: "isolated", isConnected: true, onMessage: () => () => {}, setSessionKey: () => {},
    send: async (payload: Payload) => { if (payload.type === "sessions.status") catalogs.push(payload); },
    sendSession: async (payload: Payload) => {
      if (payload.type === "mesh.snapshot") { enteredMesh(); await held; }
    } };
  const monitor = startSessionMonitor(client as never);
  t.after(() => { release(); monitor.close(); resetLocalMeshStore(); for (const n of names) {
    if (prior[n] == null) delete process.env[n]; else process.env[n] = prior[n]; }
    rmSync(root, { recursive: true, force: true }); });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([(async () => {
      await monitor.publish(); await meshDelivery; await monitor.publish();
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Mesh blocked the current catalog publisher")), 2_000); })]);
    assert.ok(catalogs.length >= 2, "fresh catalogs continue while Mesh delivery is pending");
  } finally { clearTimeout(timer); release(); }
});
