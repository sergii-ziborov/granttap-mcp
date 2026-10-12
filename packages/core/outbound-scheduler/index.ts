import { performance } from "node:perf_hooks";
import type { PeerConfig, SendOptions } from "../relay-client-types";
import type { Payload, Role } from "../../protocol/schema";
import { peerPublicKeys } from "../crypto";
import { sealEnvelope } from "../relay-envelope";

type Job = { frame: string; bytes: number; resolve: () => void; reject: (error: Error) => void };
const CLOSED = () => new Error("relay connection closed before delivery");

/** Bound bursts below the managed relay cap; explicit decisions precede replaceable snapshots. */
export class OutboundFrameQueue {
  private controls: Job[] = [];
  private snapshots: Job[] = [];
  private bytes = 0;
  private running = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private nextAt = 0;

  constructor(private readonly write: (frame: string) => Promise<void>, private readonly intervalMs = 6) {}

  send(frame: string, urgent = false): Promise<void> {
    if (this.closed) return Promise.reject(CLOSED());
    const bytes = Buffer.byteLength(frame);
    if (this.bytes + bytes > 8 * 1024 * 1024 || this.controls.length + this.snapshots.length >= 2_048) {
      return Promise.reject(new Error("relay outbound queue is full"));
    }
    return new Promise((resolve, reject) => {
      (urgent ? this.controls : this.snapshots).push({ frame, bytes, resolve, reject });
      this.bytes += bytes;
      this.schedule();
    });
  }

  cancel(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of [...this.controls, ...this.snapshots]) job.reject(CLOSED());
    this.controls = [];
    this.snapshots = [];
    this.bytes = 0;
  }

  private schedule(): void {
    if (this.closed || this.running || this.timer || (!this.controls.length && !this.snapshots.length)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); },
      Math.max(0, this.nextAt - performance.now()));
  }

  private async pump(): Promise<void> {
    if (this.closed) return;
    const job = this.controls.shift() ?? this.snapshots.shift();
    if (!job) return;
    this.running = true;
    this.bytes -= job.bytes;
    try {
      await this.write(job.frame);
      if (this.closed) throw CLOSED();
      job.resolve();
    } catch (error) { job.reject(error instanceof Error ? error : CLOSED()); }
    finally {
      this.running = false;
      this.nextAt = performance.now() + this.intervalMs;
      this.schedule();
    }
  }
}

const control = (type: Payload["type"]) => type === "hello" || type.startsWith("approval.")
  || type.startsWith("config.") || type.startsWith("pairing.") || type === "session.key.grant";

export async function sendEncryptedPayload(queue: OutboundFrameQueue, config: PeerConfig,
  allowed: (key: string) => boolean,
  delivery: { payload: Payload; to: Role | "all"; options: SendOptions }): Promise<void> {
  const { payload, to, options } = delivery;
  const peers = peerPublicKeys(config.peerPublicKey, config.extraPeerPublicKeys).filter(allowed);
  if (!peers.length) throw new Error("no authorized pairing peers");
  for (const peerPublicKey of peers) {
    await queue.send(sealEnvelope({ ...config, peerPublicKey }, payload, to,
      peers.length === 1 ? options : { ...options, deliveryId: undefined }), control(payload.type));
  }
}
