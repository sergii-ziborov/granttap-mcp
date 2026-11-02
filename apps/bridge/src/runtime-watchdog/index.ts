import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { configDir } from '../config';

export const FAULT_REPORT_URL = 'https://granttap.com/api/runtime-faults';
const BEAT_MS = 1_000;

/** Starts the monitor's hang watchdog. Its failure to start never stops the monitor. */
export function startRuntimeWatchdog(options: { version?: string; restartAllowed?: boolean; reportUrl?: string;
  directory?: string; stallMs?: number; checkMs?: number } = {}): () => void {
  try {
    const buffer = new SharedArrayBuffer(8);
    const beat = new BigInt64Array(buffer);
    const touch = () => { Atomics.store(beat, 0, BigInt(Date.now())); };
    touch();
    const timer = setInterval(touch, BEAT_MS);
    timer.unref();
    const reportsAllowed = process.env.GRANTTAP_DISABLE_FAULT_REPORTS !== '1';
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { buffer, directory: options.directory ?? join(configDir(), 'runtime-watchdog'),
        version: options.version ?? process.env.GRANTTAP_PACKAGE_VERSION ?? 'unknown',
        reportUrl: reportsAllowed ? options.reportUrl ?? FAULT_REPORT_URL : undefined,
        // Only a managed service comes back after the kill; a monitor started by hand just reports.
        restartAllowed: options.restartAllowed ?? process.env.GRANTTAP_MONITOR_PRIMARY === '1',
        ...(options.stallMs ? { stallMs: options.stallMs } : {}), ...(options.checkMs ? { checkMs: options.checkMs } : {}) },
    });
    worker.unref();
    worker.on('error', () => { clearInterval(timer); });
    return () => { clearInterval(timer); void worker.terminate(); };
  } catch {
    return () => {};
  }
}
