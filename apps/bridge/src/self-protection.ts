import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ProtectedAccess = { reason: string };

const PATH_KEYS = new Set([
  "command", "cmd", "cwd", "dir", "directory", "file", "filepath",
  "notebookpath", "path", "root", "url", "workspace", "workspaceroot", "workspaceroots",
]);

function protectedRoots(): string[] {
  const configured = process.env.GRANTTAP_CONFIG_DIR ?? process.env.NODVOX_CONFIG_DIR;
  return [
    configured,
    join(homedir(), ".granttap"),
    join(homedir(), ".nodvox"),
  ].filter((value): value is string => Boolean(value)).map((value) => resolve(value).toLowerCase());
}

function values(value: unknown, key = "", depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") {
    if (depth === 0 || PATH_KEYS.has(key.replaceAll(/[^a-z]/g, ""))) return [value];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => values(item, key, depth + 1));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([childKey, child]) => values(child, childKey.toLowerCase(), depth + 1));
}

function namesProtectedLocation(raw: string, roots: string[]): boolean {
  const text = raw.toLowerCase().replaceAll("\\", "/");
  if (text.includes(".granttap/") || text.includes("/.granttap")
      || text.includes(".nodvox/") || text.includes("/.nodvox")) return true;
  return roots.some((root) => text.includes(root.replaceAll("\\", "/")));
}

/** Best-effort hook guard for direct agent access to GrantTap's local trust state. */
export function protectedGrantTapAccess(
  _toolName: unknown,
  toolInput: unknown,
  command?: unknown,
): ProtectedAccess | null {
  const candidates = [...values(toolInput), ...values(command)];
  if (!candidates.some((value) => namesProtectedLocation(value, protectedRoots()))) return null;
  return {
    reason: "GrantTap protects its local pairing and policy files from agent tool access. Use a trusted terminal outside the agent for intentional maintenance.",
  };
}
