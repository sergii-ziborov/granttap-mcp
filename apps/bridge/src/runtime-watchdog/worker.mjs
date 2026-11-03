import { randomUUID } from 'node:crypto';
import { workerData } from 'node:worker_threads';
import { CHECK_MS, STALL_MS, faultReport, nextStep, rememberFault, sendPendingFaults, spendRestart } from './policy.mjs';

/**
 * This thread keeps its own event loop, so it still runs when the monitor's is
 * stuck. A stuck loop cannot run a shutdown handler either, which is why the
 * restart is a kill: the launcher exits with it and the service manager starts
 * a clean process. Durable jobs are not replayed after that; an attempt that
 * was running is reported as needing confirmation.
 */
const { buffer, directory, version, reportUrl, restartAllowed, stallMs = STALL_MS, checkMs = CHECK_MS } = workerData;
const beat = new BigInt64Array(buffer);
const send = () => reportUrl ? sendPendingFaults(directory, reportUrl).catch(() => 0) : Promise.resolve(0);
const within = (work, ms) => Promise.race([work, new Promise(resolve => setTimeout(resolve, ms))]);

let lastCheck = Date.now(), graceUntil = 0, reported = false, busy = false, killed = false;
const record = (kind, stalledMs, action, restartsInWindow) => {
  rememberFault(directory, faultReport({ id: randomUUID(), kind, at: Date.now(), stalledMs, action, restartsInWindow, version }));
};

async function check() {
  if (busy || killed) return;
  busy = true;
  try {
    const now = Date.now(), last = Number(Atomics.load(beat, 0));
    const step = nextStep({ now, lastCheck, beat: last, graceUntil, reported, stallMs, checkMs });
    lastCheck = now; graceUntil = step.graceUntil;
    if (step.recovered) {
      reported = false;
      record('event-loop-recovered', 0, 'none', 0);
      await send();
      return;
    }
    if (!step.stalled) return;
    const budget = restartAllowed ? spendRestart(directory, now) : { restart: false, restartsInWindow: 0 };
    if (!budget.restart && reported) return;
    record('event-loop-stall', now - last, budget.restart ? 'restart' : 'held', budget.restartsInWindow);
    reported = true;
    await within(send(), 5_000);
    if (budget.restart) {
      // macOS can let this thread run briefly after the kill; under load a second
      // check spent another restart on the same hang.
      killed = true;
      process.kill(process.pid, 'SIGKILL');
    }
  } catch { /* A watchdog fault must never become the monitor's fault. */ }
  finally { busy = false; }
}

setInterval(() => void check(), checkMs);
void send();
setInterval(() => void send(), 60 * 60_000).unref();
