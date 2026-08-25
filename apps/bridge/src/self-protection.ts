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

const READ_ONLY_ENTRIES = new Set([
  "logs", "monitor.log", "monitor.lock", "delivery-ledger.json",
]);
const WORKSPACE_ENTRIES = new Set(["workspaces", "worktrees"]);
const READ_TOOLS = new Set([
  "read", "readfile", "read_file", "view", "viewfile", "view_file",
]);
const SHELL_TOOLS = new Set([
  "bash", "command", "execcommand", "exec_command", "runterminalcmd",
  "shell", "shellcommand", "shell_command", "terminal",
]);
const SAFE_SHELL_READERS = new Set(["cat", "grep", "head", "ls", "stat", "tail", "wc"]);

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

type EntryAccess = "deny" | "read-only" | "workspace";

function entryAccess(entry: string): EntryAccess {
  if (!entry || /[*?[\]]/.test(entry) || /(^|\/)\.\.(\/|$)/.test(entry)) return "deny";
  const root = entry.split("/")[0] ?? "";
  if (WORKSPACE_ENTRIES.has(root)) return "workspace";
  return READ_ONLY_ENTRIES.has(root) ? "read-only" : "deny";
}

function normalizedToolName(toolName: unknown): string {
  return String(toolName ?? "").split("__").at(-1)!.toLowerCase();
}

function readOnlyShell(command: unknown): boolean {
  const text = String(command ?? "").trim();
  if (!text || /[;`\n]|\$\(|&&|\|\|/.test(text)) return false;
  const withoutStderrMerge = text.replaceAll(/\d*>&\d+/g, "");
  if (/[<>]/.test(withoutStderrMerge)) return false;
  return text.split("|").every((part) => {
    const words = part.trim().split(/\s+/);
    const executable = words[0] === "command" ? words[1] : words[0];
    return Boolean(executable && SAFE_SHELL_READERS.has(executable.split("/").at(-1)!));
  });
}

function shellCommand(toolInput: unknown, command: unknown): unknown {
  if (typeof command === "string") return command;
  if (!toolInput || typeof toolInput !== "object") return toolInput;
  const input = toolInput as Record<string, unknown>;
  return input.command ?? input.cmd;
}

function decide(toolName: unknown, toolInput: unknown, command: unknown): ProtectedAccess | null {
  const candidates = [...values(toolInput), ...values(command)];
  const access = candidates.flatMap((value) =>
    configReferences(value, protectedRoots()).map(entryAccess));
  if (access.length === 0 || access.every((value) => value === "workspace")) return null;
  const tool = normalizedToolName(toolName);
  const readAllowed = access.every((value) => value === "workspace" || value === "read-only")
    && (READ_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && readOnlyShell(shellCommand(toolInput, command))));
  if (readAllowed) return null;
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
  toolName: unknown,
  toolInput: unknown,
  command?: unknown,
): ProtectedAccess | null {
  try {
    return decide(toolName, toolInput, command);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[granttap] self-protection fault, allowing this call: ${detail}\n`);
    return null;
  }
}
