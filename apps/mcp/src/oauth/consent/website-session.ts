/**
 * The coding-app browser talks only to granttap.com.
 * This helper publishes the public consent snapshot there. A QR scan — a
 * phone marked seen — is the Approve. Deny stays a website action.
 * Consent snapshots contain no pairing keys; account recovery sends only a
 * sealed phone half through a separate short-lived mailbox.
 */
import { PENDING_TTL_MS } from "./pending";
import type { ConnectSnapshot } from "../session/connect-snapshot";
import { loadAccountLink, saveAccountLink } from "../../../../bridge/src/account-recovery/link";

export type ConnectDecision = "approve" | "deny" | "passkey";
export type ConsentMethod = "phone" | "passkey";

type ConnectRow = ConnectSnapshot & {
  decision?: ConnectDecision;
  redirectUrl?: string;
  error?: string;
  accountId?: string;
  machineId?: string;
  machineToken?: string;
};

function headers(secret?: string, json = false): Record<string, string> {
  return { accept: "application/json", ...(json ? { "content-type": "application/json" } : {}),
    ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
}

function acceptAccountLink(row: ConnectRow): void {
  if (row.decision !== "passkey" || !row.accountId || !row.machineId) {
    throw new Error("Passkey did not link this Mac to an account.");
  }
  const existing = loadAccountLink();
  if (row.machineToken) {
    if (!saveAccountLink({ accountId: row.accountId, machineId: row.machineId,
      machineToken: row.machineToken })) throw new Error("Account link could not be saved.");
  } else if (!existing || existing.accountId !== row.accountId
      || existing.machineId !== row.machineId) {
    throw new Error("This account is not linked to this Mac.");
  }
}

const watchers = new Map<string, AbortController>();

export function websiteOrigin(): string | undefined {
  const raw = process.env.GRANTTAP_WEBSITE_ORIGIN;
  if (raw === "") return undefined;
  if (raw) return raw.replace(/\/$/, "");
  if (process.env.GRANTTAP_SKIP_WEBSITE === "1" || process.env.NODE_TEST_CONTEXT) {
    return undefined;
  }
  return "https://granttap.com";
}

export async function publishConnectRequest(
  origin: string,
  requestId: string,
  snapshot: ConnectSnapshot,
  requestSecret?: string,
): Promise<void> {
  const response = await fetch(`${origin}/api/connect/requests/${requestId}`, {
    method: "PUT",
    headers: headers(requestSecret, true),
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`GrantTap website rejected the connection request (${response.status}).`);
  }
}

/** Reauthenticate must land on granttap.com with a live row before the browser arrives. */
export async function publishConnectRequestRetry(
  origin: string,
  requestId: string,
  snapshot: ConnectSnapshot,
  attempts = 3,
  requestSecret?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await publishConnectRequest(origin, requestId, snapshot, requestSecret);
      return true;
    } catch {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  return false;
}

export async function readConnectRequest(
  origin: string,
  requestId: string,
  requestSecret?: string,
): Promise<ConnectRow | undefined> {
  const response = await fetch(`${origin}/api/connect/requests/${requestId}`, {
    headers: headers(requestSecret),
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
  requestSecret?: string,
): Promise<void> {
  await fetch(`${origin}/api/connect/requests/${requestId}`, {
    method: "PUT",
    headers: headers(requestSecret, true),
    body: JSON.stringify({ error: error.slice(0, 300) }),
    signal: AbortSignal.timeout(4_000),
  }).catch(() => {});
}

export function watchConnectDecision(
  origin: string,
  requestId: string,
  snapshot: ConnectSnapshot | (() => ConnectSnapshot),
  complete: (approve: boolean, method: ConsentMethod) => { redirectUrl: string },
  options: { pollMs?: number; requestSecret?: string } = {},
): void {
  const current = (): ConnectSnapshot => (typeof snapshot === "function" ? snapshot() : snapshot);
  const pollMs = options.pollMs ?? 3_000;
  watchers.get(requestId)?.abort();
  const ac = new AbortController();
  watchers.set(requestId, ac);
  void (async () => {
    const deadline = Date.now() + PENDING_TTL_MS;
    let lastBody = "";
    while (!ac.signal.aborted && Date.now() < deadline) {
      try {
        const live = current();
        const row = await readConnectRequest(origin, requestId, options.requestSecret);
        if (row?.decision === "approve" || row?.decision === "deny" || row?.decision === "passkey") {
          try {
            if (row.decision === "passkey") acceptAccountLink(row);
            const { redirectUrl } = complete(row.decision !== "deny",
              row.decision === "passkey" ? "passkey" : "phone");
            await publishConnectRedirect(origin, requestId, redirectUrl);
            return;
          } catch (error) {
            await publishConnectError(
              origin,
              requestId,
              error instanceof Error ? error.message : String(error),
              options.requestSecret,
            );
            // A failed publish used to stop the watcher after deleting the
            // pending id. Approve then sat on "Waiting for this computer".
          }
        }
        const body = JSON.stringify(live);
        if (!row || body !== lastBody) {
          await publishConnectRequest(origin, requestId, live, options.requestSecret);
          lastBody = body;
        }
      } catch {
        // Keep retrying until TTL. Scan or Deny finishes consent.
      }
      await sleep(pollMs, ac.signal);
    }
  })();
}

export function resetConnectWatchers(): void {
  for (const ac of watchers.values()) ac.abort();
  watchers.clear();
}

/** The phone fetched the pairing mailbox, or a live heartbeat landed. That is consent. */
export function phoneScanApproves(snapshot: ConnectSnapshot): boolean {
  return snapshot.phones.some((phone) => phone.status === "seen");
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
