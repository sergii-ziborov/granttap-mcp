/**
 * The coding-app browser talks only to granttap.com.
 * This helper publishes the public consent snapshot there and later reads
 * Approve/Deny. Pairing keys never leave the computer.
 */
import { PENDING_TTL_MS } from "./pending";
import type { ConnectSnapshot } from "./connect-snapshot";

export type ConnectDecision = "approve" | "deny";

type ConnectRow = ConnectSnapshot & {
  decision?: ConnectDecision;
  redirectUrl?: string;
  error?: string;
};

const watchers = new Map<string, AbortController>();

export function websiteOrigin(): string | undefined {
  const raw = process.env.GRANTTAP_WEBSITE_ORIGIN;
  if (raw === "") return undefined;
  if (raw) return raw.replace(/\/$/, "");
  if (process.env.GRANTTAP_SKIP_WEBSITE === "1" || process.env.NODE_TEST_CONTEXT) {
    return undefined;
  }
  // granttap.com still resolves to Lovable. The Hetzner connect app is live on
  // the already-certified relay hostname until the apex A record moves.
  return "https://relay.granttap.com";
}

export async function publishConnectRequest(
  origin: string,
  requestId: string,
  snapshot: ConnectSnapshot,
): Promise<void> {
  const response = await fetch(`${origin}/api/connect/requests/${requestId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`GrantTap website rejected the connection request (${response.status}).`);
  }
}

export async function readConnectRequest(
  origin: string,
  requestId: string,
): Promise<ConnectRow | undefined> {
  const response = await fetch(`${origin}/api/connect/requests/${requestId}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GrantTap website request read failed (${response.status}).`);
  }
  return await response.json() as ConnectRow;
}

export async function publishConnectRedirect(
  origin: string,
  requestId: string,
  redirectUrl: string,
): Promise<void> {
  const response = await fetch(`${origin}/api/connect/requests/${requestId}/redirect`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ redirectUrl }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`GrantTap website rejected the redirect (${response.status}).`);
  }
}

export async function publishConnectError(
  origin: string,
  requestId: string,
  error: string,
): Promise<void> {
  await fetch(`${origin}/api/connect/requests/${requestId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ error: error.slice(0, 300) }),
    signal: AbortSignal.timeout(4_000),
  }).catch(() => {});
}

export function watchConnectDecision(
  origin: string,
  requestId: string,
  snapshot: ConnectSnapshot,
  complete: (approve: boolean) => { redirectUrl: string },
): void {
  watchers.get(requestId)?.abort();
  const ac = new AbortController();
  watchers.set(requestId, ac);
  void (async () => {
    const deadline = Date.now() + PENDING_TTL_MS;
    while (!ac.signal.aborted && Date.now() < deadline) {
      try {
        const row = await readConnectRequest(origin, requestId);
        if (!row) {
          await publishConnectRequest(origin, requestId, snapshot);
        } else if (row.decision === "approve" || row.decision === "deny") {
          try {
            const { redirectUrl } = complete(row.decision === "approve");
            await publishConnectRedirect(origin, requestId, redirectUrl);
          } catch (error) {
            await publishConnectError(
              origin,
              requestId,
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }
      } catch {
        // Keep retrying until TTL. The website is the only consent channel.
      }
      await sleep(1_000, ac.signal);
    }
  })();
}

export function resetConnectWatchers(): void {
  for (const ac of watchers.values()) ac.abort();
  watchers.clear();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
