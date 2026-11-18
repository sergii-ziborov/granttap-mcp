import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { LiveMapStation, SessionPulse } from "../../../../../packages/protocol/schema";

export type CallStatus = SessionPulse["status"];
export type PulseMark = NonNullable<SessionPulse["mark"]>;

/**
 * One call or moment as read from the chat's own records. `key` is the provider's id for it and
 * never travels: the stream sends a digest of it. Nothing here holds an argument or a result.
 */
export type ObservedCall = {
  key: string;
  station: LiveMapStation;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: CallStatus;
  /** The subagent whose loop made the call, by the provider's id for it. */
  agentKey?: string;
  mark?: PulseMark;
  model?: string;
};

export type Observation = {
  /** Oldest first. */
  calls: ObservedCall[];
  model?: string;
  context?: { usedTokens: number; windowTokens?: number };
  /** Subagents still at work, by the provider's id. */
  agents: string[];
};

export const emptyObservation = (): Observation => ({ calls: [], agents: [] });

/** The last `bytes` of a JSONL file as whole lines; a partial first line is dropped. */
export function tailLines(path: string, bytes: number): string[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    // One byte more than asked, so a window that starts on a line's first byte keeps that line.
    const start = Math.max(0, size - bytes - 1);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(line => line.length > 0);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const parseRow = (line: string): any => {
  try { return JSON.parse(line); } catch { return undefined; }
};

export const timeOf = (value: unknown): number => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0;
};

/** The words of a result, read only for whether a hook or the person refused the call. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 400);
  if (!Array.isArray(content)) return "";
  return content.map(block => (typeof block?.text === "string" ? block.text : "")).join(" ").slice(0, 400);
}

const REFUSED = /doesn't want to proceed|was rejected|rejected by (?:the )?user|permission .{0,40}denied|denied by|blocked by|hook (?:error|denied|blocked)|not allowed|declined/i;

/** A failed call is blocked when the words of its result say a hook or the person refused it. */
export const failedStatus = (text: string): CallStatus => (REFUSED.test(text) ? "blocked" : "error");

/** Calls by key, so that a result finds the call it ends. */
export class CallBook {
  readonly calls: ObservedCall[] = [];
  private readonly byKey = new Map<string, ObservedCall>();

  add(call: ObservedCall): void {
    if (this.byKey.has(call.key) || !call.startedAt) return;
    this.byKey.set(call.key, call);
    this.calls.push(call);
  }

  mark(key: string, station: LiveMapStation, name: string, at: number, mark: PulseMark,
    extra: Partial<ObservedCall> = {}): void {
    this.add({ key, station, name, startedAt: at, endedAt: at, status: "ok", mark, ...extra });
  }

  end(key: string, at: number, status: CallStatus): void {
    const call = this.byKey.get(key);
    if (!call || call.status !== "run") return;
    call.endedAt = Math.max(call.startedAt, at || call.startedAt);
    call.status = status;
  }

  running(station?: LiveMapStation): ObservedCall[] {
    return this.calls.filter(call => call.status === "run" && (!station || call.station === station));
  }

  observation(rest: Omit<Observation, "calls" | "agents"> & { agents?: string[] }): Observation {
    const calls = [...this.calls].sort((a, b) => a.startedAt - b.startedAt);
    const agents = rest.agents ?? this.running("agents").filter(call => !call.agentKey).map(call => call.key);
    return { ...rest, calls, agents };
  }
}
