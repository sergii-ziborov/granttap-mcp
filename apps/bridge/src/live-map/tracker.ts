import { createHash } from "node:crypto";
import {
  MAX_PULSE_FRAME_BYTES, MAX_PULSES_PER_FRAME,
  type LiveMapCounts, type SessionPulse, type SessionPulses,
} from "../../../../packages/protocol/schema";
import type { CallStatus, ObservedCall, Observation } from "./readers/shared";

/** The first frame of a subscription carries this many recent pulses to draw from. */
export const REPLAY_PULSES = 24;
/** Pulses waiting for the next frame; past this the oldest are counted as dropped. */
export const MAX_PENDING = 256;
const MAX_REMEMBERED = 1_024;
const MAX_RUNNING = 32;
const MAX_DURATION_MS = 6 * 3_600_000;

const digest = (text: string, length: number): string => createHash("sha256").update(text).digest("hex").slice(0, length);

/**
 * One phone's view of one chat. Each observation is compared with what was already sent: a new
 * call is a `start` (or `done` when it already ended), a call that ended since is an `end`. Only
 * names, stations, times and counts leave; provider ids are replaced by digests.
 */
export class PulseTracker {
  private readonly sent = new Map<string, CallStatus>();
  private readonly counts: LiveMapCounts = {};
  private pending: SessionPulse[] = [];
  private dropped = 0;
  private seq = 0;
  private seeded = false;
  private replayed = false;
  private latest?: Observation;

  constructor(private readonly sessionId: string, private readonly agent: string) {}

  private id(key: string): string { return digest(`${this.sessionId}\0${key}`, 12); }

  private pulse(call: ObservedCall, phase: SessionPulse["phase"], observation: Observation): SessionPulse {
    const parallel = phase === "end" ? 0 : observation.calls.filter(other => other.status === "run"
      && other.station === call.station && other.agentKey === call.agentKey).length;
    const duration = call.endedAt !== undefined ? Math.min(MAX_DURATION_MS, Math.max(0, call.endedAt - call.startedAt)) : undefined;
    return {
      id: this.id(call.key), station: call.station, name: call.name, phase, status: call.status,
      at: phase === "end" ? call.endedAt ?? call.startedAt : call.startedAt,
      ...(duration !== undefined && phase !== "start" && !call.mark ? { durationMs: duration } : {}),
      ...(call.agentKey ? { agentId: digest(`agent\0${call.agentKey}`, 8) } : {}),
      ...(parallel >= 2 ? { parallel: Math.min(99, parallel) } : {}),
      ...(call.mark ? { mark: call.mark } : {}),
      ...(call.model ? { model: call.model } : {}),
    };
  }

  private remember(key: string, status: CallStatus): void {
    this.sent.delete(key);
    this.sent.set(key, status);
    while (this.sent.size > MAX_REMEMBERED) this.sent.delete(this.sent.keys().next().value!);
  }

  private queue(pulse: SessionPulse): void {
    this.pending.push(pulse);
    if (this.pending.length > MAX_PENDING) {
      this.dropped += this.pending.length - MAX_PENDING;
      this.pending = this.pending.slice(-MAX_PENDING);
    }
  }

  /** Compare what the chat's records say now with what this phone already has. */
  observe(observation: Observation): void {
    this.latest = observation;
    if (!this.seeded) {
      this.seeded = true;
      for (const call of observation.calls) {
        this.counts[call.station] = (this.counts[call.station] ?? 0) + 1;
        this.remember(call.key, call.status);
      }
      const recent = observation.calls.slice(-REPLAY_PULSES);
      const older = observation.calls.slice(0, -REPLAY_PULSES).filter(call => call.status === "run").slice(-8);
      for (const call of [...older, ...recent]) this.queue(this.pulse(call, call.status === "run" ? "start" : "done", observation));
      return;
    }
    for (const call of observation.calls) {
      const before = this.sent.get(call.key);
      if (before === undefined) {
        this.counts[call.station] = (this.counts[call.station] ?? 0) + 1;
        this.queue(this.pulse(call, call.status === "run" ? "start" : "done", observation));
      } else if (before === "run" && call.status !== "run") this.queue(this.pulse(call, "end", observation));
      else if (before === call.status) continue;
      this.remember(call.key, call.status);
    }
  }

  /** Whether a frame now would say something the phone does not have. */
  get hasNews(): boolean { return this.pending.length > 0 || !this.replayed; }

  /** The next frame: at most `MAX_PULSES_PER_FRAME` pulses and `MAX_PULSE_FRAME_BYTES` bytes. */
  frame(now: number): SessionPulses {
    const observation = this.latest ?? { calls: [], agents: [] };
    let pulses = this.pending.slice(-MAX_PULSES_PER_FRAME);
    let dropped = this.dropped + this.pending.length - pulses.length;
    const context = observation.context;
    const base = (list: SessionPulse[], lost: number): SessionPulses => ({
      type: "session.pulses", sessionId: this.sessionId, agent: this.agent, seq: this.seq,
      ...(!this.replayed ? { replay: true } : {}),
      pulses: list, ...(lost > 0 ? { dropped: Math.min(lost, 1_000_000) } : {}),
      running: observation.calls.filter(call => call.status === "run").slice(-MAX_RUNNING).map(call => this.id(call.key)),
      counts: { ...this.counts },
      ...(observation.agents.length ? { agents: observation.agents.slice(0, 12).map(key => digest(`agent\0${key}`, 8)) } : {}),
      ...(observation.model ? { model: observation.model } : {}),
      ...(context?.windowTokens ? { contextPercent: Math.max(0, Math.min(100,
        Math.round((context.usedTokens / context.windowTokens) * 100))) } : {}),
      ...(context ? { contextTokens: Math.min(100_000_000, context.usedTokens) } : {}),
      generatedAt: now,
    });
    let frame = base(pulses, dropped);
    while (pulses.length > 0 && Buffer.byteLength(JSON.stringify(frame)) > MAX_PULSE_FRAME_BYTES) {
      pulses = pulses.slice(1);
      dropped += 1;
      frame = base(pulses, dropped);
    }
    this.pending = [];
    this.dropped = 0;
    this.seq += 1;
    this.replayed = true;
    return frame;
  }
}
