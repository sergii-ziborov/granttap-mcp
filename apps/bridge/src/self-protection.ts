import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ProtectedAccess = { reason: string };

const PATH_KEYS = new Set([
  "command", "cmd", "cwd", "dir", "directory", "file", "filepath",
  "notebookpath", "path", "root", "url", "workspace", "workspaceroot", "workspaceroots",
]);

/**
 * The config directory named as a path component.
 *
 * The boundary before the dot matters: a bare substring match also fires on the
 * LaunchAgent label `com.granttap.monitor` and on any other identifier that
 * happens to contain the product name, which denies calls that never touch the
 * directory at all.
 */
const CONFIG_MARKER = /(?:^|[\s'"`;|&<>()=~:/])\.(?:granttap|nodvox)(?=$|[\s'"`;|&<>()/])/g;

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

/**
 * Every entry this reference names inside a config root.
 *
 * A candidate is usually a whole shell command rather than one clean path, so
 * each hit is cut at the first shell separator — and every hit is collected,
 * because one readable log in a command line must not carry a second, protected
 * path past the guard.
 */
function configReferences(raw: string, roots: string[]): string[] {
  const text = raw.toLowerCase().replaceAll("\\", "/");
  const entries: string[] = [];
  const record = (rest: string) => {
    entries.push(rest.replace(/^\/+/, "").split(/[\s'"`;|&<>()$]/)[0] ?? "");
  };
  for (const root of roots.map((value) => value.replaceAll("\\", "/"))) {
    for (let index = text.indexOf(root); index >= 0; index = text.indexOf(root, index + 1)) {
      record(text.slice(index + root.length));
    }
  }
  for (const match of text.matchAll(CONFIG_MARKER)) {
    record(text.slice((match.index ?? 0) + match[0].length));
  }
  return entries;
}

function readableEntry(entry: string): boolean {
  if (!entry) return false;
  if (/[*?[\]]/.test(entry)) return false;
  if (/(^|\/)\.\.(\/|$)/.test(entry)) return false;
  return READABLE_ENTRIES.has(entry.split("/")[0] ?? "");
}

function namesProtectedLocation(raw: string, roots: string[]): boolean {
  const entries = configReferences(raw, roots);
  return entries.length > 0 && entries.some((entry) => !readableEntry(entry));
}

function decide(toolInput: unknown, command: unknown): ProtectedAccess | null {
  const candidates = [...values(toolInput), ...values(command)];
  if (!candidates.some((value) => namesProtectedLocation(value, protectedRoots()))) return null;
  return {
    reason: "GrantTap protects its local pairing, key, and policy files from agent tool access. "
      + "Helper logs stay readable; use a trusted terminal outside the agent for maintenance.",
  };
}

/**
 * Best-effort hook guard for direct agent access to GrantTap's local trust
 * state.
 *
 * It denies only what it positively recognised. A fault inside the guard itself
 * is reported and allowed through: this is self-protection, not an operating
 * system boundary, and a guard that blocks every tool call on every machine the
 * moment its own code faults is a far larger outage than the file it was
 * watching. The fault is loud so it gets fixed rather than lived with.
 */
export function protectedGrantTapAccess(
  _toolName: unknown,
  toolInput: unknown,
  command?: unknown,
): ProtectedAccess | null {
  try {
    return decide(toolInput, command);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[granttap] self-protection fault, allowing this call: ${detail}\n`);
    return null;
  }
}
