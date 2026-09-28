import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderHook } from "../../../../packages/protocol/messages/provider-hooks";
import { codexHookRpc, type HookRpc } from "./rpc";
import { projectCodexHooks } from "./projection";
import { codexHookSet } from "./config";

export { codexHookRpc, type HookRpc, type HookRpcOptions } from "./rpc";
export { projectCodexHooks, ownedHookCommands, codexPolicyReady, codexHooksReady } from "./projection";
export { codexHookSet } from "./config";
export { trustCodexHook } from "./trust";

export type CodexHookReport = { hooks: ProviderHook[]; checkedAt: number };
let report: CodexHookReport | undefined;
let pending: Promise<CodexHookReport> | undefined;
let cacheScope = "";

function scope(): string {
  return [process.env.GRANTTAP_CODEX_DIR, process.env.NODVOX_CODEX_DIR, process.env.CODEX_HOME,
    process.env.GRANTTAP_CODEX_BIN, homedir()].join("\u001f");
}

function hasUserHook(): boolean {
  const home = process.env.GRANTTAP_CODEX_DIR ?? process.env.NODVOX_CODEX_DIR ??
    process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const hooks = codexHookSet(readFileSync(join(home, "config.toml"), "utf8"));
    return hooks.policy || hooks.permission;
  } catch { return false; }
}

export async function readCodexHooks(rpc: HookRpc = codexHookRpc()): Promise<CodexHookReport> {
  try {
    return { hooks: projectCodexHooks(await rpc("hooks/list", { cwds: [homedir()] })), checkedAt: Date.now() };
  } catch {
    return { hooks: projectCodexHooks(null), checkedAt: Date.now() };
  }
}

export function cachedCodexHooks(): CodexHookReport | undefined {
  return cacheScope === scope() && report && Date.now() - report.checkedAt <= 45_000 ? report : undefined;
}

/** Bound subprocess work on both the monitor and loopback status poll. */
export function refreshCodexHooks(force = false): Promise<CodexHookReport> {
  const currentScope = scope();
  if (currentScope !== cacheScope) { report = undefined; cacheScope = currentScope; }
  if (pending) return pending;
  if (!force && report && Date.now() - report.checkedAt < 15_000) return Promise.resolve(report);
  // Do not initialize Codex or its cache on computers with no GrantTap hook definition.
  pending = (hasUserHook() ? readCodexHooks() : Promise.resolve({
    hooks: projectCodexHooks({ data: [{ hooks: [] }] }), checkedAt: Date.now(),
  })).then(value => { if (currentScope === scope()) report = value; return value; })
    .finally(() => { pending = undefined; });
  return pending;
}

export { handleHookTrust } from "./relay";
