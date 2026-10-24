import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

type LiveActivity = { state: 'working' | 'waiting' | 'idle'; updatedAt: number };

export function grokResumeActivity(session: { sessionId: string; cwd?: string }): LiveActivity | undefined {
  if (!session.cwd || !/^[a-zA-Z0-9_-]{1,256}$/.test(session.sessionId)) return undefined;
  const root = process.env.GRANTTAP_GROK_SESSIONS_DIR
    ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'sessions');
  return grokNativeActivity(session.sessionId, join(root, encodeURIComponent(session.cwd), session.sessionId));
}

/** Native events, unlike summary.json, advance during a long running turn. */
export function grokNativeActivity(sessionId: string, directory: string, now = Date.now()): LiveActivity | undefined {
  const root = process.env.GRANTTAP_GROK_DIR ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
  if (!ownedSession(root, sessionId)) return undefined;
  const lines = tail(join(directory, 'events.jsonl'));
  for (const line of lines.reverse()) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    const updatedAt = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(updatedAt) || updatedAt > now + 5_000) continue;
    if (row.type === 'turn_ended') return { state: 'idle', updatedAt };
    if (row.type === 'turn_started') return { state: 'working', updatedAt };
    if (row.type !== 'phase_changed') continue;
    if (row.phase === 'permission_prompt') return { state: 'waiting', updatedAt };
    if (['waiting_for_model', 'streaming_reasoning', 'streaming_text', 'tool_execution'].includes(String(row.phase))) {
      return { state: 'working', updatedAt };
    }
  }
  return undefined;
}

function ownedSession(root: string, sessionId: string): boolean {
  try {
    const path = join(root, 'active_sessions.json');
    if (statSync(path).size > 512_000) return false;
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(rows) || rows.length > 256) return false;
    const row = rows.find(item => item?.session_id === sessionId);
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isFinite(row.pid_start)) return false;
    process.kill(row.pid, 0);
    // Grok records microseconds. Match the OS start time so a reused PID cannot hold a Task.
    const started = Date.parse(execFileSync('ps', ['-p', String(row.pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
      env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1_024,
    }).trim());
    return Math.abs(started - row.pid_start / 1_000) < 1_000;
  } catch { return false; }
}

function tail(path: string): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(path).size, length = Math.min(size, 64 * 1_024);
    fd = openSync(path, 'r'); const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    return size > length ? lines.slice(1) : lines;
  } catch { return []; }
  finally { if (fd != null) closeSync(fd); }
}
