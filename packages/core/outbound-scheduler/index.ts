import { performance } from "node:perf_hooks";
import type { PeerConfig, SendOptions } from "../relay-client-types";
import type { Payload, Role } from "../../protocol/schema";
import { peerPublicKeys } from "../crypto";
import { sealEnvelope } from "../relay-envelope";

type Job = { frame: string; bytes: number; resolve: () => void; reject: (error: Error) => void };
const CLOSED = () => new Error("relay connection closed before delivery");
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export const MAX_QUEUED_FRAMES = 2_048;
/** A queued snapshot is replaceable: a newer frame takes its place rather than being refused. */
const SUPERSEDED = () => new Error("relay outbound snapshot superseded by newer traffic");

/** Bound bursts below the managed relay cap; explicit decisions precede replaceable snapshots. */
export class OutboundFrameQueue {
  private controls: Job[] = [];
  private snapshots: Job[] = [];
  private bytes = 0;
  private running = false;
  private inFlight?: Job;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private nextAt = 0;
  private ingressWindow?: number;
  private sentFrames = 0;
  private receivedFrames = 0;

  constructor(private readonly write: (frame: string) => Promise<void>, private readonly intervalMs = 6) {}

  /** Read receipts bound TCP bursts; they never acknowledge application delivery. */
  enableIngressWindow(window: number | undefined): void {
    if (!Number.isSafeInteger(window) || window! < 16) return;
    this.ingressWindow = Math.min(window!, 64);
    this.schedule();
  }

  acknowledgeIngress(received: number): void {
    if (this.ingressWindow === undefined || !Number.isSafeInteger(received)
      || received <= this.receivedFrames || received > this.sentFrames) return;
    this.receivedFrames = received;
    this.schedule();
  }

  private get hasIngressCredit(): boolean {
    return this.ingressWindow === undefined || this.sentFrames - this.receivedFrames < this.ingressWindow;
  }

  send(frame: string, urgent = false): Promise<void> {
    if (this.closed) return Promise.reject(CLOSED());
    const bytes = Buffer.byteLength(frame);
    // The oldest replaceable snapshots make room; only a queue of decisions and answers is full.
    while (this.full(bytes) && this.snapshots.length) {
      const dropped = this.snapshots.shift()!;
      this.bytes -= dropped.bytes;
      this.superseded += 1;
      dropped.reject(SUPERSEDED());
    }
    if (this.full(bytes)) return Promise.reject(new Error("relay outbound queue is full"));
    return new Promise((resolve, reject) => {
      (urgent ? this.controls : this.snapshots).push({ frame, bytes, resolve, reject });
      this.bytes += bytes;
      this.schedule();
    });
  }

  /** Queued snapshot frames dropped for newer traffic since this queue was made. */
  superseded = 0;

  private full(bytes: number): boolean {
    return this.bytes + bytes > MAX_QUEUED_BYTES || this.controls.length + this.snapshots.length >= MAX_QUEUED_FRAMES;
  }

  cancel(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight?.reject(CLOSED());
    for (const job of [...this.controls, ...this.snapshots]) job.reject(CLOSED());
    this.controls = [];
    this.snapshots = [];
    this.bytes = 0;
  }

  private schedule(): void {
    if (this.closed || this.running || this.timer || !this.hasIngressCredit
      || (!this.controls.length && !this.snapshots.length)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); },
      Math.max(0, this.nextAt - performance.now()));
  }

  private async pump(): Promise<void> {
    if (this.closed || !this.hasIngressCredit) return;
    const job = this.controls.shift() ?? this.snapshots.shift();
    if (!job) return;
    this.running = true;
    this.inFlight = job;
    this.bytes -= job.bytes;
    this.sentFrames += 1;
    try {
      await this.write(job.frame);
      if (this.closed) throw CLOSED();
      job.resolve();
    } catch (error) { job.reject(error instanceof Error ? error : CLOSED()); }
    finally {
      if (this.inFlight === job) this.inFlight = undefined;
      this.running = false;
      this.nextAt = performance.now() + this.intervalMs;
      this.schedule();
    }
  }
}

/**
 * Answers a phone waits on go here, never among replaceable snapshots: a snapshot can be dropped for
 * newer traffic, and an answer behind a backed-up upload arrives after the phone stopped waiting.
 */
const PHONE_ANSWERS = new Set<Payload["type"]>(["session.image.chunk", "session.changes.result", "session.commit.result",
  "device.manage.result", "session.workspace.result", "task.schedules.result", "task.automations.result"]);

export const priorityControlPayload = (type: Payload["type"]) => type === "hello" || PHONE_ANSWERS.has(type)
  || type.startsWith("approval.") || type.startsWith("config.") || type.startsWith("pairing.") || type === "session.key.grant"
  || type === "delivery.receipt" || type === "sessions.status" || type === "machine.heartbeat" || type === "approvals.status";

export async function sendEncryptedPayload(queue: OutboundFrameQueue, config: PeerConfig,
  allowed: (key: string) => boolean,
  delivery: { payload: Payload; to: Role | "all"; options: SendOptions }): Promise<void> {
  const { payload, to, options } = delivery;
  const peers = peerPublicKeys(config.peerPublicKey, config.extraPeerPublicKeys).filter(allowed);
  if (!peers.length) throw new Error("no authorized pairing peers");
  for (const peerPublicKey of peers) {
    await queue.send(sealEnvelope({ ...config, peerPublicKey }, payload, to,
      peers.length === 1 ? options : { ...options, deliveryId: undefined }), priorityControlPayload(payload.type) || options.urgent === true || options.wake === true);
  }
}
