import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyConfigSet,
  configMutationDigest,
  currentConfigRevision,
  setRequireFreshCommands,
} from "../../apps/bridge/src/config/commands";

function isolate(): void {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-config-"));
}

test("config.set with the same operationId does not apply twice", () => {
  isolate();
  const first = applyConfigSet({
    type: "config.set",
    meshEnabled: false,
    createdAt: 1,
    operationId: "op-1",
    baseRevision: 0,
    payloadDigest: configMutationDigest({
      type: "config.set", meshEnabled: false, createdAt: 1,
    }),
  }, 1_000);
  assert.equal(first.kind, "applied");
  const replay = applyConfigSet({
    type: "config.set",
    meshEnabled: false,
    createdAt: 1,
    operationId: "op-1",
    payloadDigest: configMutationDigest({
      type: "config.set", meshEnabled: false, createdAt: 1,
    }),
  }, 2_000);
  assert.deepEqual(replay, { kind: "replay", revision: 1 });
  assert.equal(currentConfigRevision(), 1);
});

test("the same operationId with a different digest is rejected", () => {
  isolate();
  applyConfigSet({
    type: "config.set", meshEnabled: false, createdAt: 1, operationId: "op-2",
  }, 1_000);
  const again = applyConfigSet({
    type: "config.set", meshEnabled: true, createdAt: 1, operationId: "op-2",
  }, 2_000);
  assert.deepEqual(again, { kind: "rejected", reason: "digest_mismatch" });
});

test("an older baseRevision cannot roll back a later config", () => {
  isolate();
  applyConfigSet({
    type: "config.set", meshEnabled: false, createdAt: 1, operationId: "a", baseRevision: 0,
  }, 1_000);
  const stale = applyConfigSet({
    type: "config.set",
    contextCompilerEnabled: true,
    createdAt: 2,
    operationId: "b",
    baseRevision: 0,
  }, 2_000);
  assert.deepEqual(stale, { kind: "rejected", reason: "conflict" });
});

test("expired command context is refused", () => {
  isolate();
  const result = applyConfigSet({
    type: "config.set", meshEnabled: false, createdAt: 1, operationId: "late", expiresAt: 10,
  }, 200_000);
  assert.deepEqual(result, { kind: "rejected", reason: "expired" });
});

test("legacy config.set is blocked once a pinned host is applied", () => {
  isolate();
  setRequireFreshCommands(true);
  const result = applyConfigSet({ type: "config.set", meshEnabled: false, createdAt: 1 }, 1_000);
  assert.deepEqual(result, { kind: "rejected", reason: "legacy_blocked" });
});
