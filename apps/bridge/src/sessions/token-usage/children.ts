import type { ChildThreadInfo } from "../../../../../packages/protocol/schema";
import { replacesChild } from "../support/child-threads";
import type { TokenHour } from "./hours";

type ChildHours = { summary: ChildThreadInfo; hours?: readonly TokenHour[] };

/**
 * The subagents' hours a chat's `tokensSession` counts: `aggregateChildThreads` adds one child per
 * thread id, so two logs naming the same subagent count once here too, the same one.
 */
export function uniqueChildTokenHours(children: readonly ChildHours[]): Array<readonly TokenHour[] | undefined> {
  const kept = new Map<string, ChildHours>();
  for (const child of children) {
    if (replacesChild(kept.get(child.summary.threadId)?.summary, child.summary)) kept.set(child.summary.threadId, child);
  }
  return [...kept.values()].map((child) => child.hours);
}
