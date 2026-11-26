import { failedRequest, pollAnswer, recordAccountCheck } from "../account-link-state";
import { AccountPollLease, type PollerRole } from "./lease";
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
    return { sealed: createRecoveryOffer(item, poll.machineId), refusal: false };
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
  // The new phone key is on disk already; the processes that relay to phones hear of it once it is posted,
  // so a monitor that restarts to read it never drops an offer it had not sent yet.
  else poll.pairingChanged();
}

/** Poll the account bridge; the server receives only an encrypted phone half or refusal. */
export async function pollAccountRecoveryOnce(origin: string, request: typeof fetch = fetch,
  pairingChanged: () => void = () => {}, stillAnswering: () => boolean = () => true): Promise<void> {
  const link = loadAccountLink();
  if (!link) return;
  if (new URL(origin).protocol !== "https:") throw new Error("Account recovery requires HTTPS.");
  const headers = { authorization: `Bearer ${link.machineToken}`, accept: "application/json" };
  let response: Response;
  try {
    response = await request(`${origin}/api/account/machine/requests`, {
      headers, signal: AbortSignal.timeout(8_000), redirect: "error",
    });
  } catch (error) {
    recordAccountCheck("poll", failedRequest(error));
    throw error;
  }
  // 200 confirms the sign-in, 401 is a revoked one; the answer is this computer's account-link state.
  recordAccountCheck("poll", await pollAnswer(response));
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
    // Renewed before each answer: a slow poll never outlives its lease into another process's answer.
    if (!stillAnswering()) return;
    try {
      await answer(item, poll);
    } catch (error) {
      // A transient failure retains its sealed answer for a later attempt.
      report(item.id, error);
    }
  }
}

export type PollerOptions = { role?: PollerRole; lease?: AccountPollLease; request?: typeof fetch; intervalMs?: number };

/**
 * Poll every ten seconds while this process holds the computer's one poller lease (`lease/`). Each GrantTap
 * process that runs starts this; the others only ask for the lease, so one answers each phone, and the
 * account server's last-seen time for this computer stays fresh while any of them runs.
 */
export function startAccountRecoveryPoller(origin: string, pairingChanged: () => void,
  options: PollerOptions = {}): () => void {
  const lease = options.lease ?? new AccountPollLease(options.role ?? "service");
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped || !loadAccountLink() || !lease.claim()) return;
    busy = true;
    try { await pollAccountRecoveryOnce(origin, options.request ?? fetch, pairingChanged, () => !stopped && lease.claim()); }
    catch { /* retry on next tick */ }
    finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 10_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    lease.release();
    answers.clear(); refused.clear(); reported.clear();
  };
}
