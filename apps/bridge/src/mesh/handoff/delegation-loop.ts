import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";

const MAX_HOPS = 2;

type Hop = { operationId: string; parentSessionId?: string; hops: number };

type File = { hops: Hop[] };

export function delegationLoopPath(): string {
  return join(configDir(), "delegation-loop.json");
}

function load(): Hop[] {
  try {
    const raw = JSON.parse(readFileSync(delegationLoopPath(), "utf8")) as File;
    return Array.isArray(raw.hops) ? raw.hops : [];
  } catch {
    return [];
  }
}

export type DelegationResult =
  | { ok: true; hops: number }
  | { ok: false; reason: "loop" };

/** A bot creating a task from another session. Phone-originated creates have no parent. */
export function recordDelegation(input: {
  operationId: string;
  parentSessionId?: string;
}): DelegationResult {
  const hops = load();
  const previous = hops.find((item) => item.operationId === input.operationId);
  if (previous) return previous.hops > MAX_HOPS ? { ok: false, reason: "loop" } : { ok: true, hops: previous.hops };
  const parent = input.parentSessionId
    ? hops.find((item) => item.operationId === input.parentSessionId)
    : undefined;
  const next = (parent?.hops ?? 0) + (input.parentSessionId ? 1 : 0);
  if (next > MAX_HOPS) return { ok: false, reason: "loop" };
  writePrivateFile(delegationLoopPath(), `${JSON.stringify({
    hops: [...hops, { operationId: input.operationId, parentSessionId: input.parentSessionId, hops: next }].slice(-256),
  }, null, 2)}\n`);
  return { ok: true, hops: next };
}
