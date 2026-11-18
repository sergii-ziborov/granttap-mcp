import type { SessionInfo, SessionPulses, SessionPulsesSubscription } from "../../../../packages/protocol/schema";
import type { RelayClient, SendOptions } from "../../../../packages/core/relay-client";
import { sendSessionPayload } from "../host/session-keys";
import type { Observation } from "./readers/shared";
import { PulseTracker } from "./tracker";

/** Live maps open at once on this computer's phones; a fifth takes the place of the oldest. */
export const MAX_SUBSCRIPTIONS = 4;
/** A subscription the phone stops renewing ends after this. */
export const SUBSCRIPTION_TTL_MS = 20_000;
/** Pulses are batched: at most one frame a second for each open map. */
export const TICK_MS = 1_000;
/** With nothing new, a frame still goes this often, so the phone can tell the map is live. */
export const KEEPALIVE_MS = 5_000;
/** A frame the phone has not read by then is of no use to it; the relay drops it. */
export const FRAME_TTL_MS = 10_000;

type Subscription = { key: string; sessionId: string; peer?: string; expiresAt: number; lastSentAt: number;
  granted: boolean; tracker?: PulseTracker };

type Client = Pick<RelayClient, "send" | "sendSession" | "setSessionKey" | "hasSessionKey"> & Partial<Pick<RelayClient, "retainedUnchanged">>;

export type LiveMapDependencies = {
  session: (sessionId: string) => SessionInfo | undefined;
  observe: (session: SessionInfo) => Observation;
  /** False while the relay is down or another monitor routes: then nothing is read or sent. */
  active: () => boolean;
  now?: () => number;
};

/**
 * The phones that have a chat's live map open, and the frames they are sent. Frames travel under
 * the chat's own key to the phone that asked, as replaceable snapshots: never into the relay's
 * mailbox and never ahead of an answer. The chat's key is granted once per subscription.
 */
export class LiveMapStream {
  private readonly subscriptions = new Map<string, Subscription>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly client: Client, private readonly deps: LiveMapDependencies) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  get open(): number { return this.subscriptions.size; }

  /** Start, renew or end one phone's subscription; a new one is answered at once. */
  subscribe(message: SessionPulsesSubscription, peer?: string): boolean {
    const key = `${message.sessionId}\0${peer ?? ""}`;
    if (!message.active) {
      this.subscriptions.delete(key);
      this.idle();
      return true;
    }
    const existing = this.subscriptions.get(key);
    const expiresAt = this.now() + SUBSCRIPTION_TTL_MS;
    if (existing) {
      existing.expiresAt = expiresAt;
      return true;
    }
    while (this.subscriptions.size >= MAX_SUBSCRIPTIONS) this.subscriptions.delete(this.subscriptions.keys().next().value!);
    this.subscriptions.set(key, { key, sessionId: message.sessionId, peer, expiresAt, lastSentAt: 0, granted: false });
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
      this.timer.unref?.();
    }
    void this.tick();
    return true;
  }

  private idle(): void {
    if (this.subscriptions.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round: expired subscriptions end, and each open map gets at most one frame. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const [key, subscription] of this.subscriptions) {
        if (subscription.expiresAt <= now) this.subscriptions.delete(key);
      }
      this.idle();
      if (!this.deps.active()) return;
      for (const subscription of [...this.subscriptions.values()]) await this.serve(subscription, now);
    } finally {
      this.ticking = false;
    }
  }

  private async serve(subscription: Subscription, now: number): Promise<void> {
    const session = this.deps.session(subscription.sessionId);
    if (!session) return;
    subscription.tracker ??= new PulseTracker(subscription.sessionId, session.agent);
    try {
      subscription.tracker.observe(this.deps.observe(session));
    } catch { return; }
    if (!subscription.tracker.hasNews && now - subscription.lastSentAt < KEEPALIVE_MS) return;
    const frame = subscription.tracker.frame(now);
    subscription.lastSentAt = now;
    try {
      await this.send(frame, subscription);
      subscription.granted = true;
    } catch {
      // A superseded or undelivered frame; the next one names what still runs and the counts.
    }
  }

  private send(frame: SessionPulses, subscription: Subscription): Promise<void> {
    const options: SendOptions = { reliable: false, ttlMs: FRAME_TTL_MS,
      ...(subscription.peer ? { peerPublicKey: subscription.peer } : {}) };
    if (subscription.granted && this.client.hasSessionKey(subscription.sessionId)) {
      return this.client.sendSession(frame, subscription.sessionId, "phone", options);
    }
    return sendSessionPayload(this.client as RelayClient, frame, subscription.sessionId, "phone", options);
  }

  stop(): void {
    this.subscriptions.clear();
    this.idle();
  }
}
