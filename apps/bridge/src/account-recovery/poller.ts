import { loadAccountLink } from "./link";
import { createRecoveryOffer, type RecoveryRequest } from "./offer";

type PendingResponse = { requests?: RecoveryRequest[] };
const offers = new Map<string, string>();

/** Poll the account bridge; the server receives only an encrypted phone half. */
export async function pollAccountRecoveryOnce(origin: string, request: typeof fetch = fetch,
  pairingChanged: () => void = () => {}): Promise<void> {
  const link = loadAccountLink();
  if (!link) return;
  if (new URL(origin).protocol !== "https:") throw new Error("Account recovery requires HTTPS.");
  const headers = { authorization: `Bearer ${link.machineToken}`, accept: "application/json" };
  const response = await request(`${origin}/api/account/machine/requests`, {
    headers, signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Account recovery poll failed (${response.status}).`);
  const body = await response.json() as PendingResponse;
  if (!Array.isArray(body.requests)) throw new Error("Invalid account recovery response.");
  const live = new Set(body.requests.map(item => item.id));
  for (const id of offers.keys()) if (!live.has(id)) offers.delete(id);
  for (const item of body.requests) {
    try {
      let offer = offers.get(item.id);
      if (!offer) {
        offer = createRecoveryOffer(item, link.machineId);
        pairingChanged();
      }
      offers.set(item.id, offer);
      const sent = await request(`${origin}/api/account/machine/requests/${item.id}/offer`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ encryptedOffer: offer }),
        signal: AbortSignal.timeout(8_000), redirect: "error",
      });
      if (sent.ok || sent.status === 404) offers.delete(item.id);
    } catch {
      // A transient failure retains its sealed offer for a later attempt.
    }
  }
}

export function startAccountRecoveryPoller(origin: string, pairingChanged: () => void): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pollAccountRecoveryOnce(origin, fetch, pairingChanged); } catch { /* retry on next tick */ }
    finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 10_000);
  timer.unref();
  return () => { clearInterval(timer); offers.clear(); };
}
