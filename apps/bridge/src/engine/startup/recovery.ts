type EngineRecovery = {
  prepare: () => Promise<boolean>;
  available: () => Promise<boolean>;
  recover: () => Promise<void>;
  publishCatalog: () => Promise<unknown>;
  failed?: (error: unknown) => void;
  schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
};

/** Keep catalog delivery independent of downloads, retry offline preparation, and supervise recovery. */
export function startEngineRecovery(options: EngineRecovery): () => void {
  let stopped = false, prepared = false, healthy = false;
  let timer: NodeJS.Timeout | undefined;
  const report = (error: unknown): void => { options.failed?.(error); };
  const publish = async (): Promise<boolean> => {
    try { await options.publishCatalog(); return true; } catch (error) { report(error); return false; }
  };
  let catalog = publish();
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    let retry = true;
    try {
      if (!prepared) prepared = await options.prepare();
      if (stopped) return;
      if (!prepared) { retry = false; return; }
      const available = await options.available();
      if (stopped) return;
      if (available && !healthy) {
        if (!await catalog) catalog = publish();
        if (!await catalog || stopped) return;
        await options.recover();
        healthy = true;
      } else if (!available) healthy = false;
    } catch (error) { healthy = false; report(error); }
    finally {
      if (!stopped && retry) {
        timer = (options.schedule ?? setTimeout)(() => void tick(), healthy ? 30_000 : 60_000);
        timer.unref();
      }
    }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
