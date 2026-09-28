import assert from "node:assert/strict";
import test from "node:test";
import { trustCodexHook, ownedHookCommands, type HookRpc } from "../index";

const now = Date.now();
const request = { type: "provider.hook.trust", agent: "codex", endpointId: "mac", event: "PreToolUse",
  key: 'user."policy"', currentHash: "a".repeat(64), requestId: "review", createdAt: now };
function fixture(changes: Record<string, unknown> = {}) {
  const hook = { key: request.key, eventName: "preToolUse", handlerType: "command", source: "user",
    isManaged: false, matcher: ".*", timeoutSec: 30, command: ownedHookCommands().policy,
    enabled: false, currentHash: request.currentHash, trustStatus: "modified", ...changes };
  const calls: Array<{ method: string; params: any }> = [];
  const rpc: HookRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "hooks/list") return { data: [{ hooks: [hook], errors: [] }] };
    const edits = (params as any).edits;
    assert.deepEqual(edits.map((x: any) => x.keyPath), [
      `hooks.state.${JSON.stringify(request.key)}.trusted_hash`,
      `hooks.state.${JSON.stringify(request.key)}.enabled`,
    ]);
    hook.enabled = true; hook.trustStatus = "trusted";
    return { status: "ok" };
  };
  return { hook, calls, rpc };
}

test("a reviewed current hash enables one owned hook and waits for native confirmation", async () => {
  const f = fixture();
  const result = await trustCodexHook(request, "mac", f.rpc, now);
  assert.equal(result?.ok, true);
  assert.equal(result?.hooks[0]?.trustStatus, "trusted");
  assert.deepEqual(f.calls.map(x => x.method), ["hooks/list", "config/batchWrite", "hooks/list"]);
  assert.equal(f.calls[1]?.params.reloadUserConfig, true);
});

test("stale approvals, other endpoints and foreign definitions cannot save trust", async () => {
  for (const input of [{ ...request, currentHash: "old" }, { ...request, key: "other" },
    { ...request, endpointId: "other" }, { ...request, createdAt: now - 300_001 },
    { ...request, createdAt: now + 300_001 }, { ...request, event: "PermissionRequest" }]) {
    const f = fixture();
    assert.equal((await trustCodexHook(input, "mac", f.rpc, now))?.ok, false);
    assert.equal(f.calls.some(x => x.method === "config/batchWrite"), false);
  }
  for (const changes of [{ source: "project" }, { command: "echo unrelated" }, { isManaged: true }]) {
    const f = fixture(changes);
    assert.equal((await trustCodexHook(request, "mac", f.rpc, now))?.ok, false);
    assert.equal(f.calls.some(x => x.method === "config/batchWrite"), false);
  }
  assert.equal(await trustCodexHook({}, "mac", fixture().rpc, now), undefined);
});

test("configuration override, unavailable RPC and changed-after-save remain unconfirmed", async () => {
  const f = fixture();
  for (const state of ["okOverridden", undefined]) {
    const rpc: HookRpc = (method, params) => method === "config/batchWrite"
      ? Promise.resolve({ status: state }) : f.rpc(method, params);
    assert.equal((await trustCodexHook(request, "mac", rpc, now))?.ok, false);
  }
  assert.equal((await trustCodexHook(request, "mac", async () => { throw Error("private"); }, now))?.ok, false);
  const changed = fixture();
  const rpc: HookRpc = async (method, params) => {
    const result = await changed.rpc(method, params);
    if (method === "config/batchWrite") changed.hook.currentHash = "b".repeat(64);
    return result;
  };
  assert.equal((await trustCodexHook(request, "mac", rpc, now))?.ok, false);
});
