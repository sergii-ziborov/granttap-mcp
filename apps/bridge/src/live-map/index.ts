import type { SessionPulsesSubscription } from "../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../packages/core/relay-client";
import { pendingApprovalRequests } from "../approvals/state";
import { publishedSession } from "../session-catalog";
import { liveMapObserver } from "./observe";
import { LiveMapStream } from "./stream";

export { classifyCall, commandOf, modelName, pulseName } from "./classification/tools";
export { shellStation } from "./classification/shell";
export { liveMapObserver } from "./observe";
export { PulseTracker } from "./tracker";
export { LiveMapStream } from "./stream";

const streams = new WeakMap<RelayClient, LiveMapStream>();

/** A phone opened, renewed or closed a chat's live map. */
export function handleLiveMapSubscription(client: RelayClient, payload: SessionPulsesSubscription,
  peerPublicKey?: string): boolean {
  let stream = streams.get(client);
  if (!stream) {
    if (!payload.active) return true;
    stream = new LiveMapStream(client, {
      session: sessionId => publishedSession(client, sessionId),
      observe: liveMapObserver({ pending: () => pendingApprovalRequests() }),
      active: () => client.isConnected,
    });
    streams.set(client, stream);
  }
  return stream.subscribe(payload, peerPublicKey);
}

/** The monitor stopped: no map is fed any longer. */
export function stopLiveMap(client: RelayClient): void {
  streams.get(client)?.stop();
  streams.delete(client);
}
