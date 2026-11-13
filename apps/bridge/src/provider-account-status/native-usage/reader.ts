import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { projectCursorPeriodUsage, projectNativeAccountUsage, type NativeUsageProvider } from "./projection";
import { CHECK_EVERY_MS, createUsageMemory, isSignedOutUsage, signedOutUsage, type SharedUsage } from "./memory";
export { isSignedOutUsage, SIGNED_OUT_SUFFIX, signedOutUsage } from "./memory";

type Options = {
  credential: (provider: NativeUsageProvider) => Promise<string | undefined>;
  /** Tells an expired login from none, so a lapsed login is reported rather than silent. */
  expired?: (provider: NativeUsageProvider) => Promise<boolean>;
  /** The login is live, but its access token waits for the provider's own CLI to renew it. */
  renewable?: (provider: NativeUsageProvider) => Promise<boolean>;
  saved?: SharedUsage;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  /** Told when a signed-in account's limits become unreadable or readable again; never given a credential. */
  report?: (provider: NativeUsageProvider, reason: string | undefined) => void;
};

/** How long the last good reading is still offered, with the time it was really read, while reads fail. */
export const HELD_USAGE_MS = 24 * 3_600_000;
const MARKER_MS = 300_000;

const requests = {
  claude: { url: "https://api.anthropic.com/api/oauth/usage", method: "GET" },
  cursor: { url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus", method: "POST" },
  grok: { url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits", method: "GET" },
} as const;

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
  const memory = createUsageMemory(options.saved, clock, provider => provider in requests);
  const { reports, restore, remember } = memory;
  let pending: Promise<void> | undefined;
  let attemptedAt = -Infinity;
  // Missing limits used to leave no trace; one line per change of reason keeps the log readable.
  const reasons = new Map<NativeUsageProvider, string | undefined>();
  const note = (provider: NativeUsageProvider, reason: string | undefined) => {
    if (reasons.has(provider) ? reasons.get(provider) === reason : reason === undefined) return;
    reasons.set(provider, reason);
    options.report?.(provider, reason);
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
      restore();
      const now = clock();
      // Another process on this computer has just read it, or the provider asked everyone to wait.
      if (!memory.due(provider, now)) return;
      memory.claim(provider, now);
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
      if (report) { memory.succeeded(provider); reports.set(provider, report); remember(); }
      else if (response.ok) reports.delete(provider);
      else memory.refused(provider, response);
      note(provider, report ? undefined : response.ok ? "unrecognized response" : `HTTP ${response.status}`);
    } catch (error) {
      memory.refused(provider);
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
      if (clock() - attemptedAt < CHECK_EVERY_MS) return Promise.resolve();
      attemptedAt = clock();
      pending = Promise.allSettled((Object.keys(requests) as NativeUsageProvider[]).map(update))
        .then(() => undefined).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
