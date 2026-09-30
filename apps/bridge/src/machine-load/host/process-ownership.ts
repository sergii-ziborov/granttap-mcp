/** Classify provider processes and follow their child-process ancestry. */
import { commandPreviewFromInput } from "../../sessions/telemetry/command-preview";
import type { ProcessRow } from "./process-sampler";

const MAX_DETAIL = 120;
const INTERPRETERS = /^(node|bun|deno|python3?|npx)$/;

const AGENT_EXECUTABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["claude", ["claude"]],
  ["codex", ["codex"]],
  ["cursor", ["cursor"]],
  ["grok", ["grok"]],
];

/** The executable path of a row: stated, else the command line's first word. */
export function executableOf(row: Pick<ProcessRow, "command" | "executable">): string {
  return row.executable ?? (row.command.trim().split(/\s+/)[0] ?? "");
}

function leafOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/** What to call a process: the executable's own name, wherever it lives. */
export function processGroupName(row: Pick<ProcessRow, "command" | "executable"> | string): string {
  const executable = typeof row === "string" ? row : executableOf(row);
  // npm retitles itself "npm run test:coverage"; the kind of process is npm.
  const leaf = leafOf(executable).replace(/^-/, "").split(/\s+/)[0] ?? "";
  return (leaf || "process").slice(0, 64);
}

/** Exclude desktop chat apps and framework helpers that collide with CLI names. */
function isDesktopAppHelper(path: string): boolean {
  if (path.includes("/Contents/Resources/")) return false;
  if (path.includes(".app/Contents/Frameworks/")) return true;
  return /\/(Claude|ChatGPT)\.app\//.test(path);
}

/** The arguments after the executable, when the command line repeats it. */
function argumentsOf(row: Pick<ProcessRow, "command" | "executable">): string[] {
  const command = row.command.trim();
  const executable = row.executable?.trim();
  if (executable && command.startsWith(executable)) {
    return command.slice(executable.length).trim().split(/\s+/).filter(Boolean);
  }
  return command.split(/\s+/).slice(1);
}

function agentForRow(row: Pick<ProcessRow, "command" | "executable">): string | undefined {
  const executable = executableOf(row);
  const leaf = leafOf(executable).toLowerCase();
  if (!leaf || isDesktopAppHelper(executable) || isDesktopAppHelper(row.command)) return undefined;
  for (const [agent, executables] of AGENT_EXECUTABLES) {
    if (executables.includes(leaf)) return agent;
  }
  if (INTERPRETERS.test(leaf)) {
    const script = argumentsOf(row)[0] ?? "";
    // `codex.js` is codex; the extension is how node was asked, not what ran.
    const scriptLeaf = leafOf(script).toLowerCase().replace(/\.(m?js|cjs|ts|py)$/, "");
    for (const [agent, executables] of AGENT_EXECUTABLES) {
      if (executables.includes(scriptLeaf)) return agent;
    }
  }
  return undefined;
}

/**
 * Which agent a process belongs to: the one it is, or the one that spawned
 * it. A Bash call, a node worker, a search — an agent's work is mostly done
 * by its children, and counting only the agent binary itself read "Claude:
 * one process" while forty of its children were the load.
 */
type Ownership = {
  /** pid → agent, for every process an agent is or started. */
  agents: Map<number, string>;
  /** pid → the nearest ancestor (or itself) that is the agent's own binary: one chat's root. */
  roots: Map<number, number>;
};

export function attributeByAncestry(rows: readonly ProcessRow[]): Ownership {
  const direct = new Map<number, string | undefined>();
  const parent = new Map<number, number>();
  for (const row of rows) {
    direct.set(row.pid, agentForRow(row));
    if (row.ppid != null && row.ppid !== row.pid) parent.set(row.pid, row.ppid);
  }
  const agents = new Map<number, string>();
  const roots = new Map<number, number>();
  for (const row of rows) {
    let pid: number | undefined = row.pid;
    const chain: number[] = [];
    let agent: string | undefined;
    let root: number | undefined;
    for (let depth = 0; pid != null && depth < 32; depth += 1) {
      if (direct.get(pid)) { agent = direct.get(pid); root = pid; break; }
      const known = agents.get(pid);
      if (known) { agent = known; root = roots.get(pid); break; }
      chain.push(pid);
      pid = parent.get(pid);
    }
    if (!agent) continue;
    for (const member of [...chain, row.pid]) {
      agents.set(member, agent);
      if (root != null) roots.set(member, root);
    }
  }
  return { agents, roots };
}

/** The arguments a process was given, shown without its own path and without secrets. */
export function processDetail(row: Pick<ProcessRow, "command" | "executable">): string | undefined {
  const args = argumentsOf(row).join(" ");
  const preview = commandPreviewFromInput(args);
  return preview ? preview.slice(0, MAX_DETAIL) : undefined;
}
