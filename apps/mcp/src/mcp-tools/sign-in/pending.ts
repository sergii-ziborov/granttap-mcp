import type { RelayClient } from "../../../../../packages/core/relay-client";
import { randomId } from "../../../../../packages/core/crypto";
import type { SignInRequest, SignInResult } from "../../../../../packages/protocol/schema";
import { sendSessionPayload } from "../../../../bridge/src/host/session-keys";
import { replayLoopbackCallback, type CallbackReplay } from "./callback-replay";

/**
 * One sign-in the phone was asked for, and the only result that may answer it.
 *
 * The request is bound when it is sent: to its id, to the pairing room, to the
 * phones it was sealed for, and to the chat that asked. A result is taken once,
 * while the request still waits; the redirect it carries is delivered to the
 * port this request declared and to no other.
 */
export type PendingSignIn = {
  id: string;
  room: string;
  sessionId?: string;
  peers: ReadonlySet<string>;
  callbackPort?: number;
  expiresAt: number;
  state: "waiting" | "settled";
};

export type SignInOutcome =
  | { status: "completed"; callback: "relayed"; callbackStatus: number }
  | { status: "completed"; callback: "unreachable" | "none"; callbackStatus: null }
  | { status: "cancelled" | "timed_out"; callback: "none"; callbackStatus: null };

export type SignInAsk = {
  url: string;
  service: string;
  reason?: string;
  callbackPort?: number;
  sessionId?: string;
  timeoutMs: number;
};

type Replay = (port: number, callback: unknown) => Promise<CallbackReplay>;

export function answersSignIn(
  pending: PendingSignIn,
  result: SignInResult,
  from: { room: string; peerPublicKey: string },
  now: number,
): boolean {
  return pending.state === "waiting"
    && result.id === pending.id
    && from.room === pending.room
    && pending.peers.has(from.peerPublicKey)
    && result.sessionId === pending.sessionId
    && now < pending.expiresAt;
}

/** Send the request to the phone and wait for the person, the redirect, or the end of the wait. */
export async function requestSignIn(
  client: RelayClient,
  ask: SignInAsk,
  replay: Replay = replayLoopbackCallback,
): Promise<SignInOutcome> {
  const createdAt = Date.now();
  const pending: PendingSignIn = {
    id: randomId(12), room: client.room, sessionId: ask.sessionId, peers: new Set(client.authorizedPeers),
    callbackPort: ask.callbackPort, expiresAt: createdAt + ask.timeoutMs, state: "waiting",
  };
  const wait = listen(client, pending, replay);
  try {
    const request: SignInRequest = {
      type: "signin.request", id: pending.id, sessionId: ask.sessionId, url: ask.url, service: ask.service,
      reason: ask.reason, callbackPort: ask.callbackPort, createdAt, expiresAt: pending.expiresAt,
    };
    const options = { ttlMs: ask.timeoutMs, wake: true };
    if (ask.sessionId) await sendSessionPayload(client, request, ask.sessionId, "phone", options);
    else await client.send(request, "phone", options);
  } catch (error) {
    wait.abandon();
    throw error;
  }
  return wait.outcome;
}

function listen(client: RelayClient, pending: PendingSignIn, replay: Replay): {
  outcome: Promise<SignInOutcome>;
  abandon: () => void;
} {
  let abandon = () => {};
  const outcome = new Promise<SignInOutcome>((resolve) => {
    let off = () => {};
    const finish = (value: SignInOutcome) => {
      pending.state = "settled";
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const quiet = { callback: "none", callbackStatus: null } as const;
    const expire = () => { if (pending.state === "waiting") finish({ status: "timed_out", ...quiet }); };
    const timer = setTimeout(expire, Math.max(0, pending.expiresAt - Date.now()));
    abandon = expire;
    off = client.onMessage(async (payload, peerPublicKey) => {
      if (payload.type !== "signin.result" || payload.id !== pending.id || !pending.peers.has(peerPublicKey)) return false;
      // A repeat of an answer already taken is consumed and dropped; anything else is not ours to take.
      if (!answersSignIn(pending, payload, { room: client.room, peerPublicKey }, Date.now())) {
        return pending.state === "settled";
      }
      // Taken before anything is awaited: a second copy of this result finds nothing waiting.
      pending.state = "settled";
      clearTimeout(timer);
      if (payload.outcome === "cancelled") finish({ status: "cancelled", ...quiet });
      else finish(await deliver(pending, payload, replay));
      return true;
    });
  });
  return { outcome, abandon };
}

async function deliver(pending: PendingSignIn, result: SignInResult, replay: Replay): Promise<SignInOutcome> {
  if (!result.callback || pending.callbackPort === undefined) {
    return { status: "completed", callback: "none", callbackStatus: null };
  }
  const replayed = await replay(pending.callbackPort, result.callback).catch((): CallbackReplay => (
    { delivered: false, reason: "unreachable" }
  ));
  return replayed.delivered
    ? { status: "completed", callback: "relayed", callbackStatus: replayed.status }
    : { status: "completed", callback: "unreachable", callbackStatus: null };
}
