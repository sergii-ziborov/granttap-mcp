import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STALL_MS = 120_000;
export const CHECK_MS = 5_000;
export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS = 60 * 60_000;
const PENDING_REPORT_LIMIT = 50;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(directory, name, value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name), next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, JSON.stringify(value), { mode: 0o600 });
  renameSync(next, path);
}

/** One step of the watchdog loop. A gap in its own timer means the computer slept, not a hang. */
export function nextStep(input) {
  const { now, lastCheck, beat, graceUntil, reported, stallMs = STALL_MS, checkMs = CHECK_MS } = input;
  const slept = now - lastCheck > checkMs * 3;
  const grace = slept ? now + stallMs : graceUntil;
  const stalled = now - beat >= stallMs && now >= grace;
  return { graceUntil: grace, stalled, recovered: !stalled && reported && now - beat < stallMs };
}

/**
 * The restart budget survives the restart it pays for. Once it is spent the
 * process stays up and only reports, so a hang that returns after every start
 * cannot become an endless restart.
 */
export function spendRestart(directory, now, limit = RESTART_LIMIT, windowMs = RESTART_WINDOW_MS) {
  const recent = readJson(join(directory, 'restarts.json'), [])
    .filter(at => Number.isFinite(at) && now - at < windowMs && at <= now);
  if (recent.length >= limit) return { restart: false, restartsInWindow: recent.length };
  recent.push(now);
  writeJson(directory, 'restarts.json', recent);
  return { restart: true, restartsInWindow: recent.length };
}

/** Only these fields leave the computer: no prompt, path, room, key or computer name. */
export function faultReport(input) {
  return { id: input.id, kind: input.kind, at: input.at, stalledMs: input.stalledMs, action: input.action,
    restartsInWindow: input.restartsInWindow, version: input.version, node: process.versions.node,
    platform: process.platform, arch: process.arch };
}

export function rememberFault(directory, report) {
  const pending = readJson(join(directory, 'pending-reports.json'), []);
  pending.push(report);
  writeJson(directory, 'pending-reports.json', pending.slice(-PENDING_REPORT_LIMIT));
}

/** Reports wait on this computer until the site confirms them, so a hang offline is not lost. */
export async function sendPendingFaults(directory, url, request = fetch) {
  const pending = readJson(join(directory, 'pending-reports.json'), []);
  const delivered = new Set();
  for (const report of pending) {
    try {
      const response = await request(url, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
        signal: AbortSignal.timeout(5_000) });
      // The site refused this report for good; it must not hold back the others.
      if (response.status === 400) { delivered.add(report.id); continue; }
      if (!response.ok) break;
      delivered.add(report.id);
    } catch { break; }
  }
  if (!delivered.size) return 0;
  const current = readJson(join(directory, 'pending-reports.json'), []);
  writeJson(directory, 'pending-reports.json', current.filter(report => !delivered.has(report.id)));
  return delivered.size;
}
