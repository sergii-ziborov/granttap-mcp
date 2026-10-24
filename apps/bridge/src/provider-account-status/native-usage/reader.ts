import type { ProviderAccountUsage } from "../../../../../packages/protocol/schema";
import { projectCursorPeriodUsage, projectNativeAccountUsage, type NativeUsageProvider } from "./projection";

type Options = {
  credential: (provider: NativeUsageProvider) => Promise<string | undefined>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
};

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
  const reports = new Map<NativeUsageProvider, ProviderAccountUsage>();
  let pending: Promise<void> | undefined;
  let attemptedAt = -Infinity;

  async function update(provider: NativeUsageProvider): Promise<void> {
    try {
      const token = await options.credential(provider);
      if (!token) { reports.delete(provider); return; }
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
      if (report) reports.set(provider, report);
      else reports.delete(provider);
    } catch { reports.delete(provider); }
  }

  return {
    current(): ProviderAccountUsage[] {
      const now = clock();
      return [...reports.values()].flatMap(report => {
        const windows = report.windows.filter(window => window.resetsAt > now);
        return now - report.observedAt <= 300_000 && windows.length ? [{ ...report, windows }] : [];
      });
    },
    refresh(): Promise<void> {
      if (pending) return pending;
      if (clock() - attemptedAt < 120_000) return Promise.resolve();
      attemptedAt = clock();
      pending = Promise.allSettled((Object.keys(requests) as NativeUsageProvider[]).map(update))
        .then(() => undefined).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
