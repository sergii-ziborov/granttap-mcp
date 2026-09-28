import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderHook, type ProviderHook as Hook } from "../../../../packages/protocol/messages/provider-hooks";

export function ownedHookCommands() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const base = `node "${join(root, "bin", "granttap-mcp.mjs")}" internal hook`;
  return { policy: `${base} codex-policy`, permission: `${base} codex` };
}

/** Only the two exact user-config hooks installed by this runtime are reviewable. */
export function projectCodexHooks(value: unknown): Hook[] {
  const commands = ownedHookCommands();
  const report = value as { data?: Array<{ hooks?: any[]; errors?: unknown[] }> } | null;
  const data = Array.isArray(report?.data) ? report.data : [];
  return (["PreToolUse", "PermissionRequest"] as const).map((event) => {
    const missing: Hook = { event, trustStatus: data.length ? "missing" : "unknown", enabled: false };
    if (data.length !== 1 || (data[0]?.errors?.length ?? 0) > 0) {
      return { ...missing, trustStatus: "unknown" };
    }
    const rows = Array.isArray(data[0]?.hooks) ? data[0]!.hooks! : [];
    const candidates = rows.filter((row) => row?.eventName === (event === "PreToolUse" ? "preToolUse" : "permissionRequest")
      && row.handlerType === "command" && row.source === "user" && row.isManaged === false
      && row.command === commands[event === "PreToolUse" ? "policy" : "permission"]
      && row.matcher === ".*" && row.timeoutSec === (event === "PreToolUse" ? 30 : 120));
    if (candidates.length !== 1) return missing;
    const row = candidates[0];
    const parsed = ProviderHook.safeParse({ event, enabled: row.enabled, trustStatus: row.trustStatus,
      key: row.key, currentHash: row.currentHash, command: row.command });
    if (!parsed.success || !parsed.data.key || !parsed.data.currentHash) {
      return { ...missing, trustStatus: "unknown" };
    }
    return parsed.data;
  });
}

export function codexPolicyReady(hooks?: Hook[]): boolean {
  return hooks?.some(row => row.event === "PreToolUse" && row.enabled && row.trustStatus === "trusted") ?? false;
}

export function codexHooksReady(hooks?: Hook[]): boolean {
  return hooks?.length === 2 && new Set(hooks.map(row => row.event)).size === 2
    && hooks.every(row => row.enabled && row.trustStatus === "trusted");
}
