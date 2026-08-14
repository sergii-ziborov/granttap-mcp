export type PublishLoopOptions = {
  connected: () => boolean;
  intervalMs: number;
  publish: () => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
};

/**
 * Schedule from completion, never from a fixed timer.
 *
 * A full provider scan can take many seconds. A `setInterval` keeps firing
 * through it, so the scans stack up, saturate the event loop, and starve the
 * relay socket — the phone then sees nothing and calls the computer offline.
 */
export function startPublishLoop(options: PublishLoopOptions): () => void {
  const schedule = options.schedule ?? setTimeout;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (options.connected()) await options.publish();
    if (!stopped) timer = schedule(() => void tick(), options.intervalMs);
  };
  timer = schedule(() => void tick(), options.intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
