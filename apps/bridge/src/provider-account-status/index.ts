import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EndpointModelCatalog } from "../../../../packages/protocol/schema";
import { codexHookRpc, type HookRpc } from "../codex-hook-trust";
import { projectAccountModels, projectAccountUsage } from "./projection";

export { projectAccountModels, projectAccountUsage } from "./projection";
export { cachedNativeAccountUsage } from "./native-usage";

/** A bounded read of an already signed-in provider; no threads, turns or login. */
export function createProviderAccountReader(rpc: HookRpc, clock = Date.now) {
  let value: EndpointModelCatalog | undefined;
  let pending: Promise<void> | undefined;
  let attemptedAt = -Infinity;
  return {
    current(endpointId: string): EndpointModelCatalog | undefined {
      return value && value.endpointId === endpointId && clock() - value.observedAt <= 5 * 60_000
        ? value : undefined;
    },
    refresh(endpointId: string): Promise<void> {
      if (pending) return pending;
      if (clock() - attemptedAt < 120_000) return Promise.resolve();
      attemptedAt = clock();
      pending = Promise.allSettled([
        rpc("model/list", { limit: 64, includeHidden: false }), rpc("account/rateLimits/read", {}),
      ]).then(([models, usage]) => {
        const now = clock();
        const rows = models.status === "fulfilled" ? projectAccountModels(models.value, endpointId, now) : [];
        value = { endpointId, observedAt: now, stale: rows.length === 0, models: rows,
          accountUsage: usage.status === "fulfilled" ? projectAccountUsage(usage.value, now) : [] };
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}

let scope = "";
let reader = createProviderAccountReader(codexHookRpc());

/** Catalog polling schedules account reads without delaying chat/catalog delivery. */
export function cachedProviderAccount(endpointId: string, env = process.env): EndpointModelCatalog | undefined {
  const root = env.GRANTTAP_CODEX_DIR ?? env.NODVOX_CODEX_DIR ?? env.CODEX_HOME ?? join(homedir(), ".codex");
  let identity: string;
  try { identity = `${root}:${statSync(join(root, "auth.json")).mtimeMs}`; } catch { return undefined; }
  if (identity !== scope) { scope = identity; reader = createProviderAccountReader(codexHookRpc({ env })); }
  void reader.refresh(endpointId);
  return reader.current(endpointId);
}
