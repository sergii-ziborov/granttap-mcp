import { hostname } from "node:os";
import type { RelayClient } from "../../../packages/core/relay-client";

/**
 * Liveness cadence, deliberately independent of the catalog scan.
 *
 * The phone calls a computer offline after 90s without evidence. Three
 * heartbeats must fit inside that window so a single dropped frame — or one
 * slow scan — never turns a healthy machine into "Mac offline".
 */
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.GRANTTAP_MONITOR_HEARTBEAT_MS ?? 10_000,
);

/**
 * Publish liveness only — no scanning, no catalog, no transcripts.
 *
 * Sent transiently: a durable copy would pile up in the relay mailbox and be
 * replayed later as evidence of a machine that has since gone away.
 */
export async function publishHeartbeat(client: RelayClient): Promise<void> {
  await client.send(
    { type: "machine.heartbeat", machine: hostname(), createdAt: Date.now() },
    "phone",
    { ttlMs: HEARTBEAT_INTERVAL_MS * 3, reliable: false },
  );
}
