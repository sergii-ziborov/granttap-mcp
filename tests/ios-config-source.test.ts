/**
 * Auto-accept is configured from iOS only.
 *
 * The phone is the single source of truth: it sends `config.set`, the Mac
 * monitor persists it, and the hooks only ever read the stored level. This
 * pins that write path — default, pause, and a per-session override, plus the
 * fact that an unrelated config.set does not disturb auto-accept.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleConfigSet } from "../apps/bridge/src/monitor";
import { loadRuntimeConfig } from "../apps/bridge/src/config";

function withConfigDir(t: { after: (fn: () => void) => void }): void {
  const dir = mkdtempSync(join(tmpdir(), "granttap-ios-config-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("iOS sets the default auto-accept level", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "full", createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptDefault, "full");
});

test("iOS pauses and un-pauses auto-accept", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptPaused: true, createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptPaused, true);
  handleConfigSet({ type: "config.set", autoAcceptPaused: false, createdAt: 0 });
  assert.equal(loadRuntimeConfig().autoAcceptPaused, false);
});

test("iOS sets and clears a per-session override", (t) => {
  withConfigDir(t);
  handleConfigSet({
    type: "config.set",
    autoAcceptSession: { sessionId: "chat-a", level: "safe" },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptBySession["chat-a"], "safe");

  handleConfigSet({
    type: "config.set",
    autoAcceptSession: { sessionId: "chat-a", level: null },
    createdAt: 0,
  });
  assert.equal(loadRuntimeConfig().autoAcceptBySession["chat-a"], undefined);
});

test("an unrelated config.set leaves auto-accept intact", (t) => {
  withConfigDir(t);
  handleConfigSet({ type: "config.set", autoAcceptDefault: "except_push", createdAt: 0 });
  // Toggling gating for one chat must not wipe the level the phone set.
  handleConfigSet({ type: "config.set", excludeSession: "chat-z", createdAt: 0 });
  const rc = loadRuntimeConfig();
  assert.equal(rc.autoAcceptDefault, "except_push");
  assert.ok(rc.excludedSessions.includes("chat-z"));
});
