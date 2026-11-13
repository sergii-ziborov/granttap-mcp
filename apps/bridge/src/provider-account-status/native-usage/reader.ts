import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { projectCursorPeriodUsage, projectNativeAccountUsage, type NativeUsageProvider } from "./projection";

type Options = {
  credential: (provider: NativeUsageProvider) => Promise<string | undefined>;
  /** Tells an expired login from none, so a lapsed login is reported rather than silent. */
  expired?: (provider: NativeUsageProvider) => Promise<boolean>;
  /** The login is live, but its access token waits for the provider's own CLI to renew it. */
  renewable?: (provider: NativeUsageProvider) => Promise<boolean>;
  /** The last good readings, kept across restarts. Numbers only, never a credential. */
  saved?: { read: () => ProviderAccountUsage[]; write: (reports: ProviderAccountUsage[]) => void };
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  /** Told when a signed-in account's limits become unreadable or readable again; never given a credential. */
  report?: (provider: NativeUsageProvider, reason: string | undefined) => void;
};

/** A good reading is read again after two minutes; a failed read is tried again much sooner. */
const FRESH_MS = 120_000, RETRY_MS = 20_000;
/** How long the last good reading is still offered, with the time it was really read, while reads fail. */
export const HELD_USAGE_MS = 24 * 3_600_000;
const MARKER_MS = 300_000;

const requests = {
  claude: { url: "https://api.anthropic.com/api/oauth/usage", method: "GET" },
  cursor: { url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus", method: "POST" },
  grok: { url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits", method: "GET" },
} as const;

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

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) return undefined;
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

/** Independent, bounded account reads. A catalog never waits for a native login or a turn. */
export function createNativeAccountUsageReader(options: Options) {
  const clock = options.clock ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const reports = new Map<NativeUsageProvider, ProviderAccountUsage>();
  let pending: Promise<void> | undefined;
  let attemptedAt = -Infinity, failed = false;
  const restore = () => {
    try {
      for (const report of options.saved?.read() ?? []) {
        const held = reports.get(report.provider as NativeUsageProvider);
        if (report.provider in requests && !isSignedOutUsage(report) && (held?.observedAt ?? -Infinity) < report.observedAt
          && (!held || !isSignedOutUsage(held))) reports.set(report.provider as NativeUsageProvider, report);
      }
    } catch { /* A missing or damaged file only means nothing is remembered. */ }
  };
  const remember = () => {
    try { options.saved?.write([...reports.values()].filter(report => !isSignedOutUsage(report))); } catch { /* Best effort. */ }
  };
  restore();
  // Missing limits used to leave no trace; one line per change of reason keeps the log readable.
  const reasons = new Map<NativeUsageProvider, string | undefined>();
  const note = (provider: NativeUsageProvider, reason: string | undefined) => {
    if (reasons.has(provider) ? reasons.get(provider) === reason : reason === undefined) return;
    reasons.set(provider, reason);
    options.report?.(provider, reason);
  };

  /** A refused or failed request says nothing about the account: the last good reading stays, and the read is retried soon. */
  const unreadable = (provider: NativeUsageProvider) => {
    failed = true;
    if (isSignedOutUsage(reports.get(provider) ?? signedOutUsage(provider, 0))) reports.delete(provider);
    restore();
  };

  async function update(provider: NativeUsageProvider): Promise<void> {
    try {
      const token = await options.credential(provider);
      if (!token) {
        if (await options.expired?.(provider)) {
          reports.set(provider, signedOutUsage(provider, clock()));
          note(provider, "the provider's console login has expired");
        } else if (await options.renewable?.(provider)) {
          // Nothing can be read until the provider's CLI runs again; what was read last still stands.
          if (isSignedOutUsage(reports.get(provider) ?? signedOutUsage(provider, 0))) reports.delete(provider);
          restore();
          note(provider, "its saved access token has expired; the provider renews it on its next run");
        } else { reports.delete(provider); reasons.delete(provider); remember(); }
        return;
      }
      const request = requests[provider];
      const response = await fetcher(request.url, {
        method: request.method, redirect: "error", signal: AbortSignal.timeout(8_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          ...(provider === "claude" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
          ...(provider === "cursor" ? { "Connect-Protocol-Version": "1" } : {}),
        },
        ...(request.method === "POST" ? { body: "{}" } : {}),
      });
      const value = await boundedResponse(response);
      let report = projectNativeAccountUsage(provider, value, clock());
      if (provider === "cursor" && !report && value !== undefined) {
        const legacy = await fetcher("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000), body: "{}",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        });
        report = projectCursorPeriodUsage(await boundedResponse(legacy), clock());
      }
      if (report) { reports.set(provider, report); remember(); }
      else if (response.ok) reports.delete(provider);
      else unreadable(provider);
      note(provider, report ? undefined : response.ok ? "unrecognized response" : `HTTP ${response.status}`);
    } catch (error) {
      unreadable(provider);
      note(provider, error instanceof Error ? error.name : "request failed");
    }
  }

  return {
    current(): ProviderAccountUsage[] {
      const now = clock();
      return [...reports.values()].flatMap(report => {
        const windows = report.windows.filter(window => window.resetsAt > now);
        return isSignedOutUsage(report) ? (now - report.observedAt <= MARKER_MS ? [report] : [])
          : windows.length && now - report.observedAt <= HELD_USAGE_MS ? [{ ...report, windows }] : [];
      });
    },
    refresh(): Promise<void> {
      if (pending) return pending;
      if (clock() - attemptedAt < (failed ? RETRY_MS : FRESH_MS)) return Promise.resolve();
      attemptedAt = clock(); failed = false;
      pending = Promise.allSettled((Object.keys(requests) as NativeUsageProvider[]).map(update))
        .then(() => undefined).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
