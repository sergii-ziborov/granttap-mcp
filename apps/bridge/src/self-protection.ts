import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ProtectedAccess = { reason: string };

const PATH_KEYS = new Set([
  "command", "cmd", "cwd", "dir", "directory", "file", "filepath",
  "notebookpath", "path", "root", "url", "workspace", "workspaceroot", "workspaceroots",
]);

const CONFIG_MARKERS = ["/.granttap", "/.nodvox", ".granttap", ".nodvox"];

/**
 * Entries inside the config directory an agent may reach.
 *
 * Everything else is denied, including the directory itself and any glob over
 * it, so a file added tomorrow is protected the day it appears rather than the
 * day someone remembers to list it. Diagnostics stay reachable on purpose:
 * hiding the helper log only made a crash harder to explain, and the log holds
 * no key, no pairing, and no policy decision.
 */
const READABLE_ENTRIES = new Set([
  "logs", "monitor.log", "monitor.lock",
  "project-mesh.json", "mesh-tool-calls.json", "delivery-ledger.json",
  "workspaces", "worktrees",
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

/** What this reference names inside a config root, or null when it names none. */
function configRootRemainder(raw: string, roots: string[]): string | null {
  const text = raw.toLowerCase().replaceAll("\\", "/");
  for (const marker of [...roots.map((root) => root.replaceAll("\\", "/")), ...CONFIG_MARKERS]) {
    const index = text.indexOf(marker);
    if (index >= 0) return text.slice(index + marker.length).replace(/^\/+/, "");
  }
  return null;
}

function readableEntry(remainder: string): boolean {
  if (!remainder) return false;
  if (/[*?[\]]/.test(remainder)) return false;
  if (/(^|\/)\.\.(\/|$)/.test(remainder)) return false;
  return READABLE_ENTRIES.has(remainder.split("/")[0] ?? "");
}

function namesProtectedLocation(raw: string, roots: string[]): boolean {
  const remainder = configRootRemainder(raw, roots);
  return remainder != null && !readableEntry(remainder);
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
    reason: "GrantTap protects its local pairing, key, and policy files from agent tool access. "
      + "Helper logs stay readable; use a trusted terminal outside the agent for maintenance.",
  };
}
