import { loadAccountLink } from "./link";
import { createRecoveryOffer, type RecoveryRequest } from "./offer";
import { refusalFor, sealRefusal, type RefusalReason } from "./refusal";

type PendingResponse = { requests?: RecoveryRequest[] };
type Answer = { sealed: string; refusal: boolean };
type Poll = { origin: string; request: typeof fetch; headers: Record<string, string>; machineId: string;
  pairingChanged: () => void };

/** Sealed answers, an offer or a refusal, kept until the account server has one, by request id. */
const answers = new Map<string, Answer>();
/** Requests whose refusal reached the server: a phone is told why once. */
const refused = new Set<string>();
/** Requests whose failure is in the log already: one line per request, not one per poll. */
const reported = new Set<string>();

function report(id: string, error: unknown, told?: RefusalReason): void {
  if (reported.has(id)) return;
  reported.add(id);
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[account] could not answer a phone's account sign-in: ${reason}`
    + `${told ? ` (telling the phone: ${told})` : ""}\n`);
}

/** The phone's offer, or when this computer cannot admit it a sealed refusal saying why. */
function answerFor(item: RecoveryRequest, poll: Poll): Answer {
  try {
    const sealed = createRecoveryOffer(item, poll.machineId);
    poll.pairingChanged();
    return { sealed, refusal: false };
  } catch (error) {
    const refusal = refusalFor(item, poll.machineId, error);
    report(item.id, error, refusal?.reason);
    if (!refusal) throw error;
    return { sealed: sealRefusal(refusal, item.phonePublicKey), refusal: true };
  }
}

async function answer(item: RecoveryRequest, poll: Poll): Promise<void> {
  const next = answers.get(item.id) ?? answerFor(item, poll);
  answers.set(item.id, next);
  const sent = await poll.request(`${poll.origin}/api/account/machine/requests/${item.id}/offer`, {
    method: "POST", headers: { ...poll.headers, "content-type": "application/json" },
    body: JSON.stringify({ encryptedOffer: next.sealed }),
    signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (!sent.ok && sent.status !== 404) throw new Error(`the account server answered ${sent.status}`);
  answers.delete(item.id);
  if (next.refusal) refused.add(item.id);
}

/** Poll the account bridge; the server receives only an encrypted phone half or refusal. */
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
  for (const store of [answers, refused, reported]) {
    for (const id of store.keys()) if (!live.has(id)) store.delete(id);
  }
  const poll = { origin, request, headers, machineId: link.machineId, pairingChanged };
  for (const item of body.requests) {
    if (refused.has(item.id)) continue;
    try {
      await answer(item, poll);
    } catch (error) {
      // A transient failure retains its sealed answer for a later attempt.
      report(item.id, error);
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
  return () => { clearInterval(timer); answers.clear(); refused.clear(); reported.clear(); };
}
