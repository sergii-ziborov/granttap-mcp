/** Persistent idempotency ledger for phone messages and their delivery receipts. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

const LIMIT = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PROCESSING_LEASE_MS = 5 * 60_000;

type DeliveryRecord = {
  state: "processing" | "completed";
  updatedAt: number;
};

export type DeliveryStart = "started" | "processing" | "completed";

export function deliveryLedgerPath(): string {
  return join(configDir(), "delivery-ledger.json");
}

function load(): Record<string, DeliveryRecord> {
  try {
    const raw = JSON.parse(readFileSync(deliveryLedgerPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const records: Record<string, DeliveryRecord> = {};
    for (const [id, value] of Object.entries(raw)) {
      // Migrate the original `{ id: acceptedAt }` ledger as completed work.
      if (typeof value === "number") records[id] = { state: "completed", updatedAt: value };
      else if (value && typeof value === "object"
          && ((value as DeliveryRecord).state === "processing"
            || (value as DeliveryRecord).state === "completed")
          && typeof (value as DeliveryRecord).updatedAt === "number") {
        records[id] = value as DeliveryRecord;
      }
    }
    return records;
  } catch {
    return {};
  }
}

export function hasAcceptedDelivery(messageId: string, now = Date.now()): boolean {
  const record = load()[messageId];
  return record?.state === "completed" && record.updatedAt >= now - MAX_AGE_MS;
}

function save(records: Record<string, DeliveryRecord>, now: number): void {
  const cutoff = now - MAX_AGE_MS;
  const next = Object.fromEntries(Object.entries(records)
    .filter(([, record]) => record.updatedAt >= cutoff && record.updatedAt <= now)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, LIMIT));
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(deliveryLedgerPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(deliveryLedgerPath(), 0o600);
}

/** Acquire a durable processing lease before invoking an agent. */
export function beginDelivery(messageId: string, now = Date.now()): DeliveryStart {
  const records = load();
  const current = records[messageId];
  if (current?.state === "completed" && current.updatedAt >= now - MAX_AGE_MS) return "completed";
  if (current?.state === "processing" && current.updatedAt >= now - PROCESSING_LEASE_MS) {
    return "processing";
  }
  records[messageId] = { state: "processing", updatedAt: now };
  save(records, now);
  return "started";
}

export function completeDelivery(messageId: string, now = Date.now()): void {
  const records = load();
  records[messageId] = { state: "completed", updatedAt: now };
  save(records, now);
}

/** Release a failed attempt so a relay retry can safely try again. */
export function abandonDelivery(messageId: string, now = Date.now()): void {
  const records = load();
  delete records[messageId];
  save(records, now);
}

/** @deprecated Compatibility wrapper for callers/tests from the old ledger. */
export function rememberAcceptedDelivery(messageId: string, now = Date.now()): void {
  completeDelivery(messageId, now);
}
