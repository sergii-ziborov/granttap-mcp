/**
 * What a call already did, by the name the model gave it.
 *
 * A tool call is not a transaction: a Mesh event can be recorded and sent
 * before the status text fails on the wire, and a model that retries the
 * whole call would publish the event twice — or ask the person the same
 * question again. Given an operationId, the server remembers what each part
 * of a call came to and, on the same id again, does only what is still
 * undone, answering with the whole.
 */
export type OperationRecord = {
  at: number;
  tool: string;
  text: string;
  outcome: Record<string, unknown>;
  /** The part of the call that has not happened yet, to be done on the retry. */
  pending?: "message";
};

export const OPERATION_TTL_MS = 15 * 60_000;
const MAX_OPERATIONS = 64;

export class OperationLedger {
  private readonly records = new Map<string, OperationRecord>();

  constructor(private readonly ttlMs = OPERATION_TTL_MS) {}

  private key(tool: string, operationId: string): string {
    return `${tool}\0${operationId}`;
  }

  recall(tool: string, operationId: string, now = Date.now()): OperationRecord | undefined {
    const record = this.records.get(this.key(tool, operationId));
    if (!record) return undefined;
    if (now - record.at > this.ttlMs) {
      this.records.delete(this.key(tool, operationId));
      return undefined;
    }
    return record;
  }

  remember(tool: string, operationId: string, record: Omit<OperationRecord, "at" | "tool">, now = Date.now()): void {
    for (const [key, item] of this.records) {
      if (now - item.at > this.ttlMs) this.records.delete(key);
    }
    this.records.set(this.key(tool, operationId), { ...record, at: now, tool });
    while (this.records.size > MAX_OPERATIONS) {
      const oldest = this.records.keys().next().value;
      if (oldest == null) break;
      this.records.delete(oldest);
    }
  }
}
