/**
 * Closing executions a computer no longer runs.
 *
 * A session that simply disappears never reports an end, so its execution
 * stayed open forever: it went on holding the Task, blocked any live session
 * from becoming the owner, and left the Task wearing a vanished chat's title
 * and its last state — a dead chat presented as current work.
 *
 * Only providers actually observed in the scan are swept, so a provider whose
 * CLI is temporarily unavailable never has its sessions declared over.
 */
import type { ExecutionSessionLink as ExecutionValue } from "../../../../packages/protocol/schema";

export type VanishedSweep = {
  computerId: string;
  liveSessionIds: ReadonlySet<string>;
  scannedProviders: ReadonlySet<string>;
  endedAt: number;
};

export function closeVanished(
  executions: ExecutionValue[],
  { computerId, liveSessionIds, scannedProviders, endedAt }: VanishedSweep,
): number {
  let closed = 0;
  for (const execution of executions) {
    if (execution.computerId !== computerId || execution.endedAt != null) continue;
    if (!scannedProviders.has(execution.provider)) continue;
    if (liveSessionIds.has(execution.sessionId)) continue;
    execution.endedAt = endedAt;
    execution.updatedAt = endedAt;
    closed += 1;
  }
  return closed;
}
