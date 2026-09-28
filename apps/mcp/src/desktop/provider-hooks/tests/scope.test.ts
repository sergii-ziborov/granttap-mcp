import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopHookTrust } from "../index";
import { handleHookTrust, refreshCodexHooks, cachedCodexHooks } from "../../../../../bridge/src/codex-hook-trust";
import { observedComputerId } from "../../../../../bridge/src/mesh/identity/computer";
import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { ProviderHookTrust } from "../../../../../../packages/protocol/messages/provider-hooks";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-hook-boundary-"));
  const before = { ...process.env };
  process.env.GRANTTAP_CONFIG_DIR = root;
  process.env.GRANTTAP_CODEX_DIR = root;
  t.after(() => { process.env = before; rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("no-hook status does not initialize Codex, and stale desktop review never writes configuration", async t => {
  const root = fixture(t);
  const report = await refreshCodexHooks(true);
  assert.equal(report.hooks.every(row => row.trustStatus === "missing"), true);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(cachedCodexHooks()?.checkedAt, report.checkedAt);
  const input = { endpointId: observedComputerId(), event: "PreToolUse", key: "policy",
    currentHash: "hash", requestId: "old", createdAt: String(Date.now() - 600_000) };
  const result = await desktopHookTrust(input);
  assert.equal(result?.ok, false);
  assert.equal(result?.requestId, "old");
  assert.equal(await desktopHookTrust({ ...input, event: "Other" }), undefined);
  assert.deepEqual(readdirSync(root), []);
  process.env.GRANTTAP_CODEX_DIR = join(root, "other");
  assert.equal(cachedCodexHooks(), undefined, "native trust cannot leak across configurations");
});

test("only the paired controller in the same room receives hook review results", async t => {
  const root = fixture(t);
  const path = join(root, "machine.json");
  const config = JSON.stringify({ role: "machine", room: "fixture-room", relayUrl: "wss://fixture",
    myPublicKey: "fixture-public", mySecretKey: "fixture-secret", peerPublicKey: "controller" });
  writeFileSync(path, config);
  const replies: unknown[] = [];
  let published = 0;
  const client = { room: "fixture-room", sendToPeer: async (value: unknown, peer: string) => replies.push({ value, peer }) } as unknown as RelayClient;
  const request = { type: "provider.hook.trust", agent: "codex", endpointId: observedComputerId(),
    event: "PreToolUse", key: "policy", currentHash: "hash", requestId: "expired",
    createdAt: Date.now() - 600_000 } as ProviderHookTrust;
  const publish = async () => { published++; };
  assert.equal(await handleHookTrust(client, request, undefined, publish), false);
  assert.equal(await handleHookTrust(client, request, "stranger", publish), false);
  assert.equal(await handleHookTrust({ ...client, room: "other" } as RelayClient, request, "controller", publish), false);
  assert.deepEqual(replies, []);
  assert.equal(await handleHookTrust(client, request, "controller", publish), true);
  assert.equal(replies.length, 1);
  assert.equal((replies[0] as any).peer, "controller");
  assert.equal((replies[0] as any).value.ok, false);
  assert.equal(published, 1);
  assert.equal(readFileSync(path, "utf8"), config);
  assert.deepEqual(readdirSync(root), ["machine.json"]);
});
