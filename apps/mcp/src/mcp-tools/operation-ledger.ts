/**
 * What a call already did, by the name the model gave it.
 *
 * A tool call is not a transaction: a Mesh event can be recorded and sent
 * before the status text fails on the wire, and a model that retries the
 * whole call would publish the event twice — or ask the person the same
 * question again. Given an operationId, the server remembers what each part
 * of a call came to and, on the same id again, does only what is still
 * undone, answering with the whole.
 *
 * A name is only a name inside the scope that used it: the record is kept
 * under the execution the call was attributed to, so one chat's answer is
 * never another's; it carries a digest of the call's own arguments, so a
 * name reused for a different question is refused rather than answered
 * from memory; and a call still in flight is shared with its retry, so two
 * retries at once are one question.
 */
import { createHash } from "node:crypto";

export type OperationRecord = {
  at: number;
  tool: string;
  /** The call's own arguments, as a digest; a reused name with other arguments is a conflict. */
  digest: string;
  text: string;
  outcome: Record<string, unknown>;
  /** The part of the call that has not happened yet, to be done on the retry. */
  pending?: "message";
};

export const OPERATION_TTL_MS = 15 * 60_000;
const MAX_OPERATIONS = 64;

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && item !== null) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** The call's semantic arguments, named: the same words give the same digest. */
export function argumentsDigest(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}

export type Recall<T extends OperationRecord = OperationRecord> =
  | { kind: "new" }
  | { kind: "replay"; record: T }
  | { kind: "conflict"; record: T }
  | { kind: "in_flight"; result: Promise<T> };

export class OperationLedger {
  private readonly records = new Map<string, OperationRecord>();
  private readonly inFlight = new Map<string, Promise<OperationRecord>>();

  constructor(private readonly ttlMs = OPERATION_TTL_MS) {}

  private key(principal: string, tool: string, operationId: string): string {
    return `${principal}\0${tool}\0${operationId}`;
  }

  /** What this name already means for this principal, if anything. */
  recall(principal: string, tool: string, operationId: string, digest: string, now = Date.now()): Recall {
    const key = this.key(principal, tool, operationId);
    const running = this.inFlight.get(key);
    if (running) return { kind: "in_flight", result: running };
    const record = this.records.get(key);
    if (!record) return { kind: "new" };
    if (now - record.at > this.ttlMs) {
      this.records.delete(key);
      return { kind: "new" };
    }
    return record.digest === digest ? { kind: "replay", record } : { kind: "conflict", record };
  }

  /**
   * Run the call once for this name: a retry that arrives while it runs
   * waits for the same answer. The record is kept when the work settles.
   */
  async run(
    principal: string,
    tool: string,
    operationId: string,
    work: () => Promise<OperationRecord>,
    now: () => number = Date.now,
  ): Promise<OperationRecord> {
    const key = this.key(principal, tool, operationId);
    const promise = work().then((record) => {
      this.remember(principal, tool, operationId, record, now());
      return record;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  remember(principal: string, tool: string, operationId: string, record: Omit<OperationRecord, "at"> & { at?: number }, now = Date.now()): void {
    for (const [key, item] of this.records) {
      if (now - item.at > this.ttlMs) this.records.delete(key);
    }
    this.records.set(this.key(principal, tool, operationId), { ...record, at: record.at ?? now });
    while (this.records.size > MAX_OPERATIONS) {
      const oldest = this.records.keys().next().value;
      if (oldest == null) break;
      this.records.delete(oldest);
    }
  }
}
