import { DesktopTaskActivityRunner } from "../task-activity-runner";

let cached: { at: number; result: unknown } | undefined;
let inFlight: Promise<unknown> | undefined;

/** One bounded scan per refresh window, isolated from live Mesh reads. */
export function desktopUsage(): Promise<unknown> {
  if (cached && Date.now() - cached.at < 120_000) return Promise.resolve(cached.result);
  if (inFlight) return inFlight;
  const worker = new DesktopTaskActivityRunner();
  const request = worker.usage().then((result) => {
    if (result) cached = { at: Date.now(), result };
    return result;
  }).finally(() => {
    worker.close();
    inFlight = undefined;
  });
  inFlight = request;
  return request;
}
