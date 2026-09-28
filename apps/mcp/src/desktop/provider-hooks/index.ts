import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { refreshCodexHooks, trustCodexHook } from "../../../../bridge/src/codex-hook-trust";

export async function desktopHookTrust(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const result = await trustCodexHook({ ...fields, type: "provider.hook.trust", agent: "codex",
    createdAt: typeof fields.createdAt === "string" ? Number(fields.createdAt) : fields.createdAt }, observedComputerId());
  if (!result) return undefined;
  if (result.ok) await refreshCodexHooks(true);
  return { operation: "desktop.codex_hook_trust", ...result };
}
