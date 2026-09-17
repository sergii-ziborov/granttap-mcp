/** Detect that the phone fetched the one-time pairing mailbox. No keys here. */

export type MailboxPeek = "occupied" | "empty" | "unsupported";

export async function peekPairingMailbox(httpBase: string, mailboxId: string): Promise<MailboxPeek> {
  let url: URL;
  try {
    url = new URL(`/pair/${mailboxId}`, `${httpBase.replace(/\/$/, "")}/`);
  } catch {
    return "unsupported";
  }
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(4_000),
      redirect: "error",
    });
    if (response.status === 405 || response.status === 501) return "unsupported";
    if (response.ok) return "occupied";
    return "empty";
  } catch {
    return "unsupported";
  }
}

export type WatchMailboxClaimOptions = {
  peek?: typeof peekPairingMailbox;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  intervalMs?: number;
};

/**
 * After PUT the mailbox is occupied. The phone's first GET consumes it.
 * A 200 → 404 transition before expiry is the scan, not an expired code.
 */
export function watchMailboxClaim(
  httpBase: string,
  mailboxId: string,
  expiresAt: number,
  onClaimed: () => void,
  options: WatchMailboxClaimOptions = {},
): () => void {
  const peek = options.peek ?? peekPairingMailbox;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const intervalMs = options.intervalMs ?? 1_000;
  let stopped = false;
  let seenOccupied = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || now() >= expiresAt) return;
    const state = await peek(httpBase, mailboxId);
    if (stopped) return;
    if (state === "unsupported") return;
    if (state === "occupied") seenOccupied = true;
    else if (seenOccupied) {
      onClaimed();
      return;
    }
    if (!stopped && now() < expiresAt) timer = schedule(() => void tick(), intervalMs);
  };

  timer = schedule(() => void tick(), 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
