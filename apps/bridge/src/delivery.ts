/** Persistent idempotency ledger for phone messages and their delivery receipts. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

const LIMIT = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function deliveryLedgerPath(): string {
  return join(configDir(), "delivery-ledger.json");
}

function load(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(deliveryLedgerPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, number] =>
        typeof entry[0] === "string" && typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

export function hasAcceptedDelivery(messageId: string, now = Date.now()): boolean {
  const acceptedAt = load()[messageId];
  return acceptedAt != null && acceptedAt >= now - MAX_AGE_MS;
}

export function rememberAcceptedDelivery(messageId: string, now = Date.now()): void {
  const cutoff = now - MAX_AGE_MS;
  const entries = Object.entries(load())
    .filter(([, acceptedAt]) => acceptedAt >= cutoff && acceptedAt <= now)
    .sort((a, b) => b[1] - a[1]);
  const next = Object.fromEntries([[messageId, now], ...entries.filter(([id]) => id !== messageId)].slice(0, LIMIT));
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(deliveryLedgerPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
