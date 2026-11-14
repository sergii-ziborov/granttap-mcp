import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import type { NativeUsageProvider } from "./projection";

/**
 * What every GrantTap process on this computer shares: the last good readings, kept across restarts,
 * and the time before which a provider must not be asked again. Numbers only, never a credential.
 */
export type SharedUsage = { read: () => ProviderAccountUsage[]; write: (reports: ProviderAccountUsage[]) => void;
  notBefore?: () => Record<string, number>; defer?: (provider: string, until: number) => void };

/**
 * A provider limits how often its account may be read: Claude answers the fifth quick request with
 * 429 and five minutes of refusals. Dozens of GrantTap processes run on one computer, so they share
 * one read per provider every three minutes, wait as long as a refusal names, and otherwise back off.
 */
const READ_EVERY_MS = 180_000;
/** How often one process looks at the shared state; the network is asked far less often. */
export const CHECK_EVERY_MS = 60_000;
const BACKOFF_MS = 60_000, BACKOFF_MAX_MS = 600_000, RETRY_AFTER_MAX_MS = 900_000;

/**
 * A limit report with no windows whose id ends in ":signed-out": the provider is
 * installed but its own login has lapsed. The wire format is unchanged, so older
 * phones show no numbers and newer ones say why.
 */
export const SIGNED_OUT_SUFFIX = ":signed-out";
export function signedOutUsage(provider: NativeUsageProvider, now: number): ProviderAccountUsage {
  return { provider, limitId: `${provider}${SIGNED_OUT_SUFFIX}`, observedAt: now, windows: [] };
}
export function isSignedOutUsage(report: ProviderAccountUsage): boolean {
  return report.windows.length === 0 && report.limitId.endsWith(SIGNED_OUT_SUFFIX);
}

/** The readings one process holds, kept in step with the other processes on the computer. */
export function createUsageMemory(saved: SharedUsage | undefined, clock: () => number, known: (provider: string) => boolean) {
  const reports = new Map<NativeUsageProvider, ProviderAccountUsage>();
  /** Limits narrower than the account, such as one model's. They are read with the account's reading and follow it. */
  const scoped = new Map<NativeUsageProvider, ProviderAccountUsage[]>();
  const pauses = new Map<NativeUsageProvider, number>(), failures = new Map<NativeUsageProvider, number>();
  const notBefore = (provider: NativeUsageProvider) => {
    let shared = -Infinity;
    try { shared = Number(saved?.notBefore?.()[provider] ?? -Infinity); } catch { /* Only this process's pause is known. */ }
    return Math.max(pauses.get(provider) ?? -Infinity, Number.isFinite(shared) ? shared : -Infinity);
  };
  const defer = (provider: NativeUsageProvider, until: number) => {
    pauses.set(provider, until);
    try { saved?.defer?.(provider, until); } catch { /* Best effort. */ }
  };
  const restore = () => {
    try {
      const stored = saved?.read() ?? [];
      for (const report of stored) {
        const provider = report.provider as NativeUsageProvider, held = reports.get(provider);
        if (!known(provider) || report.limitId !== provider || isSignedOutUsage(report)
          || (held?.observedAt ?? -Infinity) >= report.observedAt || held && isSignedOutUsage(held)) continue;
        reports.set(provider, report);
        scoped.set(provider, stored.filter(other => other.provider === provider && other.limitId !== provider
          && !isSignedOutUsage(other)).slice(0, 4));
      }
    } catch { /* A missing or damaged file only means nothing is remembered. */ }
  };
  const persist = () => {
    const kept = [...reports.values()].filter(report => !isSignedOutUsage(report));
    try { saved?.write([...kept, ...kept.flatMap(report => scoped.get(report.provider as NativeUsageProvider) ?? [])]); }
    catch { /* Best effort. */ }
  };
  restore();
  return {
    reports, restore,
    remember(): void { restore(); persist(); },
    /** A fresh reading names every narrower limit the provider still reports; one it dropped is not kept. */
    setScoped(provider: NativeUsageProvider, limits: ProviderAccountUsage[]): void { scoped.set(provider, limits.slice(0, 4)); },
    scopedFor(provider: NativeUsageProvider): ProviderAccountUsage[] {
      const main = reports.get(provider);
      return main && !isSignedOutUsage(main) ? scoped.get(provider) ?? [] : [];
    },
    /** The login is gone: its readings leave this process and the shared file, instead of coming back from it. */
    forget(provider: NativeUsageProvider): void {
      restore(); reports.delete(provider); scoped.delete(provider); persist();
    },
    /** Not while another process has just read it, or while the provider asked everyone to wait. */
    due(provider: NativeUsageProvider, now: number): boolean {
      const held = reports.get(provider);
      return now >= notBefore(provider) && !(held && !isSignedOutUsage(held) && now - held.observedAt < READ_EVERY_MS);
    },
    claim(provider: NativeUsageProvider, now: number): void { defer(provider, now + READ_EVERY_MS); },
    succeeded(provider: NativeUsageProvider): void { failures.delete(provider); },
    /**
     * A refused or failed request says nothing about the account: the last good reading stays. Every
     * process waits as long as the provider asked, or twice as long after each failure in a row.
     */
    refused(provider: NativeUsageProvider, response?: Response): void {
      const count = (failures.get(provider) ?? 0) + 1;
      failures.set(provider, count);
      const asked = Number(response?.headers.get("retry-after"));
      defer(provider, clock() + (Number.isFinite(asked) && asked > 0 ? Math.min(asked * 1_000, RETRY_AFTER_MAX_MS)
        : Math.min(BACKOFF_MS * 2 ** (count - 1), BACKOFF_MAX_MS)));
      if (isSignedOutUsage(reports.get(provider) ?? signedOutUsage(provider, 0))) reports.delete(provider);
      restore();
    },
  };
}
