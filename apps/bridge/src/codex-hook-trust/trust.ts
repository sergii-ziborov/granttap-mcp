import { homedir } from "node:os";
import { ProviderHookTrust, type ProviderHookTrustResult } from "../../../../packages/protocol/messages/provider-hooks";
import { codexHookRpc, type HookRpc } from "./rpc";
import { projectCodexHooks } from "./projection";

/** A person approves one displayed definition; no bulk trust or sandbox bypass. */
export async function trustCodexHook(
  input: unknown, endpointId: string, rpc: HookRpc = codexHookRpc(), now = Date.now(),
): Promise<ProviderHookTrustResult | undefined> {
  const parsed = ProviderHookTrust.safeParse(input);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  let hooks = projectCodexHooks(null);
  const result = (ok: boolean, message: string): ProviderHookTrustResult => ({
    type: "provider.hook.trust.result", agent: "codex", endpointId, requestId: request.requestId,
    ok, message, hooks, checkedAt: Date.now(),
  });
  if (request.endpointId !== endpointId || Math.abs(now - request.createdAt) > 5 * 60_000) {
    return result(false, "Hook approval expired or targets another computer. Refresh and review again.");
  }
  try {
    hooks = projectCodexHooks(await rpc("hooks/list", { cwds: [homedir()] }));
    const current = hooks.find(row => row.event === request.event);
    if (!current?.command || current.key !== request.key || current.currentHash !== request.currentHash) {
      return result(false, "The hook changed or is unavailable. Refresh and review the current definition.");
    }
    const keyPath = `hooks.state.${JSON.stringify(current.key)}`;
    const write = await rpc("config/batchWrite", { edits: [
      { keyPath: `${keyPath}.trusted_hash`, value: current.currentHash, mergeStrategy: "upsert" },
      { keyPath: `${keyPath}.enabled`, value: true, mergeStrategy: "upsert" },
    ], filePath: null, expectedVersion: null, reloadUserConfig: true }) as { status?: string };
    if (write?.status !== "ok") return result(false, "Codex could not apply hook trust. Check its configuration layers.");
    hooks = projectCodexHooks(await rpc("hooks/list", { cwds: [homedir()] }));
    const applied = hooks.find(row => row.event === request.event);
    return applied?.enabled && applied.trustStatus === "trusted" && applied.key === current.key
      && applied.currentHash === current.currentHash
      ? result(true, "Codex confirmed this GrantTap hook is trusted and enabled.")
      : result(false, "Codex has not confirmed this hook is active. Refresh and review again.");
  } catch {
    return result(false, "Codex hook approval is unavailable. Retry or review the hook in Codex Settings → Hooks.");
  }
}
