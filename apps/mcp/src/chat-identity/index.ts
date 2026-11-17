/**
 * The chat an MCP server was started for, as the coding agent that started it tells it.
 *
 * - Claude Code names the chat in `CLAUDE_CODE_SESSION_ID`.
 * - Grok Build names it in `GROK_SESSION_ID`.
 * - Codex hands its MCP servers a bare environment (`HOME`, `PATH`, `SHELL`, `TMPDIR`, `USER`, …). The Codex process
 *   that started the server holds its chat's rollout (`rollout-<time>-<thread id>.jsonl`) open, so a server whose
 *   Codex process has exactly one rollout open is that chat's; a process with several (the desktop app's shared
 *   server, a chat with live subagents) names none. `CODEX_THREAD_ID` is taken if Codex ever sets it.
 * - Cursor starts one MCP server for a window's chats, so no server-wide identity exists; its MCP hook attributes
 *   each call instead (see `consumeAttributedCall`).
 *
 * Only the nearest coding agent above this server is asked: a variable inherited from a chat whose shell started
 * that agent is not this server's chat. Where the process tree cannot be read, a single provider variable is
 * taken and two are ambiguous. No chat is ever guessed from a working directory.
 */
import { nearestHost, readAncestry, readOpenFiles, type ChatHost, type HostProcess } from "./processes";

export type { ChatHost } from "./processes";

export type ChatBinding = {
  sessionId?: string;
  provider?: ChatHost;
  /** How the chat was named: by the host's environment, or by the transcript the host holds open. */
  source?: "environment" | "transcript";
  identity: "bound" | "unbound";
};

export type ChatProcessProbe = {
  /** The nearest coding agent above this server, when the process tree shows one. */
  host: () => HostProcess | undefined;
  /** Regular files a process holds open. */
  openFiles: (pid: number) => string[];
};

const ID = /^[A-Za-z0-9._-]{8,128}$/;
const VARIABLES: ReadonlyArray<readonly [ChatHost, string]> = [
  ["claude", "CLAUDE_CODE_SESSION_ID"],
  ["grok", "GROK_SESSION_ID"],
  ["codex", "CODEX_THREAD_ID"],
];
const ROLLOUT = /[/\\]sessions[/\\](?:\d{4}[/\\]\d{2}[/\\]\d{2}[/\\])?rollout-[^/\\]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** A chat's open rollout can change (a new chat in the same Codex window), so it is read again after this long. */
const OPEN_FILES_TTL_MS = 10_000;

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim() ?? "";
  return ID.test(value) ? value : undefined;
}

/** The thread whose rollout is the only one among a Codex process's open files. */
export function openCodexThread(paths: readonly string[]): string | undefined {
  const threads = new Set(paths.flatMap(path => ROLLOUT.exec(path)?.[1]?.toLowerCase() ?? []));
  return threads.size === 1 ? [...threads][0] : undefined;
}

function defaultProbe(): ChatProcessProbe {
  let host: { value: HostProcess | undefined } | undefined;
  const files = new Map<number, { at: number; paths: string[] }>();
  // Test processes are not started by a coding agent; tests that need one supply a probe.
  const disabled = () => Boolean(process.env.NODE_TEST_CONTEXT);
  return {
    host: () => {
      if (disabled()) return undefined;
      host ??= { value: nearestHost(readAncestry()) };
      return host.value;
    },
    openFiles: (pid) => {
      if (disabled()) return [];
      const cached = files.get(pid), now = Date.now();
      if (cached && now - cached.at >= 0 && now - cached.at < OPEN_FILES_TTL_MS) return cached.paths;
      const paths = readOpenFiles(pid);
      files.set(pid, { at: now, paths });
      return paths;
    },
  };
}

let probe = defaultProbe();

/** For tests: read the process tree through `next`, or the real one again when omitted. */
export function setChatProcessProbe(next?: ChatProcessProbe): void {
  probe = next ?? defaultProbe();
}

function hostChat(host: HostProcess, env: NodeJS.ProcessEnv, using: ChatProcessProbe): ChatBinding {
  const name = VARIABLES.find(([provider]) => provider === host.host)?.[1];
  const named = name ? variable(env, name) : undefined;
  if (named) return { sessionId: named, provider: host.host, source: "environment", identity: "bound" };
  if (host.host === "codex") {
    let thread: string | undefined;
    try { thread = openCodexThread(using.openFiles(host.pid)); } catch { /* No open files, no chat. */ }
    if (thread) return { sessionId: thread, provider: "codex", source: "transcript", identity: "bound" };
  }
  return { provider: host.host, identity: "unbound" };
}

/** The chat that started this MCP server, when its host names one. */
export function chatBinding(env: NodeJS.ProcessEnv = process.env, using: ChatProcessProbe = probe): ChatBinding {
  let host: HostProcess | undefined;
  try { host = using.host(); } catch { host = undefined; }
  if (host) return hostChat(host, env, using);
  const named = VARIABLES.flatMap(([provider, name]) => {
    const sessionId = variable(env, name);
    return sessionId ? [{ provider, sessionId }] : [];
  });
  return named.length === 1
    ? { ...named[0]!, source: "environment", identity: "bound" }
    : { identity: "unbound" };
}
