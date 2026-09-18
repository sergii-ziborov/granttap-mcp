import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config/paths";
import { writePrivateFile } from "../config/write-private";
import type { DeliveryState, DeliveryTarget } from "./delivery";

type File = { broadcasts: Record<string, DeliveryTarget[]> };

export function broadcastLedgerPath(): string {
  return join(configDir(), "broadcast-ledger.json");
}

function load(): File {
  try {
    const raw = JSON.parse(readFileSync(broadcastLedgerPath(), "utf8")) as File;
    return raw.broadcasts && typeof raw.broadcasts === "object" ? raw : { broadcasts: {} };
  } catch {
    return { broadcasts: {} };
  }
}

export function persistBroadcast(operationId: string, targets: DeliveryTarget[]): DeliveryTarget[] {
  const file = load();
  file.broadcasts[operationId] = targets;
  writePrivateFile(broadcastLedgerPath(), `${JSON.stringify(file, null, 2)}\n`);
  return targets;
}

export function recordTargetState(
  operationId: string,
  executionId: string,
  state: DeliveryState,
  reason?: string,
): DeliveryTarget[] {
  const file = load();
  const current = file.broadcasts[operationId] ?? [];
  const next = current.some((item) => item.executionId === executionId)
    ? current.map((item) => item.executionId === executionId ? { executionId, state, reason } : item)
    : [...current, { executionId, state, reason }];
  file.broadcasts[operationId] = next;
  writePrivateFile(broadcastLedgerPath(), `${JSON.stringify(file, null, 2)}\n`);
  return next;
}

export function loadBroadcast(operationId: string): DeliveryTarget[] {
  return load().broadcasts[operationId] ?? [];
}
