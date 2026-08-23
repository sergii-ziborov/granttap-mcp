/**
 * Shared helpers for reading agent session logs on disk.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "../../../../packages/protocol/schema";

/** A session is "working" if its log moved within this window. */
export const WORKING_MS = 90_000;
/** Beyond this idle age a session moves from the live list into history. */
export const LIVE_MS = 6 * 60 * 60 * 1000;
/** Token summary remains recent, while chat history is retained for six months. */
export const TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;
export const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const TOKEN_WINDOW_HOURS = TOKEN_WINDOW_MS / (60 * 60 * 1000);
/** Don't read the whole world — cap the scan. */
// The wire history is capped at 200 chats. Reading more than 200 logs per
// provider adds startup latency without making another row reachable.
export const MAX_FILES = 200;
export const MAX_LIVE = 40;
/** Keep every agent visible in Active even when another provider floods. */
export const LIVE_RESERVE_PER_AGENT = 10;
export const MAX_HISTORY = 320;

export type Scan = { sessions: import("../../../../packages/protocol/schema").SessionInfo[]; tokensRecent: number };

/**
 * Log-age states only. "waiting" means blocked on the user (approval / ask) and
 * must be set by the gate/MCP path — never inferred from "was active recently"
 * (that made every live chat show Waiting on the phone).
 */
export function stateFor(lastActivityAt: number): SessionState {
  const age = Date.now() - lastActivityAt;
  if (age <= WORKING_MS) return "working";
  return "idle";
}

export function safeParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function ts(value: unknown): number {
  if (typeof value === "number") {
    // Agent logs sometimes use unix seconds. Values below 1e11 (~1973 in ms)
    // cannot be millisecond timestamps for real chat history.
    if (value > 0 && value < 1e11) return value * 1000;
    return value;
  }
  if (typeof value === "string") {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      if (asNum < 1e11) return asNum * 1000;
      return asNum;
    }
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** Every recent *.jsonl under a root, newest first. */
export function recentLogs(root: string, depth = 4): string[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (dir: string, level: number): void => {
    if (level > depth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, level + 1);
      else if (name.endsWith(".jsonl") && Date.now() - st.mtimeMs <= HISTORY_RETENTION_MS) {
        out.push({ path: full, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map((f) => f.path);
}

export function claudeProjectsRoot(): string {
  return (
    process.env.GRANTTAP_CLAUDE_PROJECTS_DIR ??
    process.env.NODVOX_CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects")
  );
}

export function codexSessionsRoot(): string {
  return (
    process.env.GRANTTAP_CODEX_SESSIONS_DIR ??
    process.env.NODVOX_CODEX_SESSIONS_DIR ??
    join(homedir(), ".codex", "sessions")
  );
}

export function cursorTranscriptsRoot(): string {
  return (
    process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR ??
    join(homedir(), ".cursor", "projects")
  );
}

export function grokSessionsRoot(): string {
  return process.env.GRANTTAP_GROK_SESSIONS_DIR
    ?? join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions");
}
