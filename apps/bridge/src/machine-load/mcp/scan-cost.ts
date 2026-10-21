export type ProviderScanSample = {
  durationMs: number;
  sessions: number;
};

const samples = new Map<string, ProviderScanSample>();

/** Last measured discovery cost for every provider scanned on this computer. */
export function providerScanCost(): Record<string, ProviderScanSample> {
  return Object.fromEntries(samples);
}

/** Measure a real provider scan without changing its result. */
export function timedProviderScan<T extends { sessions: unknown[] }>(
  agent: string,
  scan: () => T,
): T {
  const startedAt = Date.now();
  const result = scan();
  samples.set(agent, {
    durationMs: Date.now() - startedAt,
    sessions: result.sessions.length,
  });
  return result;
}

/** Includes elapsed time across cooperative yields; selected capability is never usage. */
export async function timedProviderScanAsync<T extends { sessions: unknown[] }>(
  agent: string, scan: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const result = await scan();
  samples.set(agent, { durationMs: Date.now() - startedAt, sessions: result.sessions.length });
  return result;
}
