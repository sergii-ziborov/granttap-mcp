import { setImmediate } from "node:timers/promises";
import { performance } from "node:perf_hooks";

/** Shared provider readers preserve the same result for CLI and live transport callers. */
export function finishScan<T>(scan: Generator<void, T>): T {
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}

/** Let relay input, pongs, decisions and timers run between native files. */
export async function finishScanCooperatively<T>(scan: Generator<void, T>): Promise<T> {
  for (;;) {
    await setImmediate();
    const deadline = performance.now() + 8;
    do {
      const step = scan.next();
      if (step.done) return step.value;
    } while (performance.now() < deadline);
  }
}
