import type {
  ActivityEntry,
  ChildThreadInfo,
  SessionInfo,
} from "../../../../packages/protocol/schema";

/** Protocol and UI share this hard ceiling; provider logs can contain thousands. */
export const MAX_CHILD_THREADS = 32;
export const MAX_CHILD_THREAD_TITLE = 160;

export function childTitle(value: unknown): string | undefined {
  const raw = String(value ?? "");
  const selected = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1] ?? raw;
  const text = selected.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_CHILD_THREAD_TITLE) : undefined;
}

/** Keep the most recently active children while returning them chronologically. */
export function boundChildThreads(children: ChildThreadInfo[]): ChildThreadInfo[] {
  return uniqueChildThreads(children)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_CHILD_THREADS)
    .sort((a, b) => a.startedAt - b.startedAt || a.threadId.localeCompare(b.threadId));
}

function uniqueChildThreads(children: ChildThreadInfo[]): ChildThreadInfo[] {
  const byId = new Map<string, ChildThreadInfo>();
  for (const child of children) {
    const previous = byId.get(child.threadId);
    if (!previous || child.lastActivityAt >= previous.lastActivityAt) {
      byId.set(child.threadId, child);
    }
  }
  return [...byId.values()];
}

/**
 * Child spend and liveness belong to the chat that spawned the work. This is
 * deliberately additive exactly once; callers must pass own (not aggregated)
 * parent counters and a de-duplicated child list.
 */
export function aggregateChildThreads(
  parent: SessionInfo,
  children: ChildThreadInfo[],
): SessionInfo {
  const unique = uniqueChildThreads(children);
  if (unique.length === 0) return parent;
  const bounded = boundChildThreads(unique);
  const latest = unique.reduce((a, b) =>
    b.lastActivityAt >= a.lastActivityAt ? b : a
  );
  const anyWorking = unique.some((child) => child.state === "working");
  const anyWaiting = unique.some((child) => child.state === "waiting");
  return {
    ...parent,
    state: anyWorking ? "working" : anyWaiting && parent.state === "idle" ? "waiting" : parent.state,
    startedAt: Math.min(parent.startedAt, ...unique.map((child) => child.startedAt)),
    lastActivityAt: Math.max(parent.lastActivityAt, latest.lastActivityAt),
    tokensSession:
      parent.tokensSession + unique.reduce((sum, child) => sum + child.tokensSession, 0),
    tokensLastTurn:
      latest.lastActivityAt > parent.lastActivityAt
        ? latest.tokensLastTurn
        : parent.tokensLastTurn,
    childThreads: bounded,
  };
}

export function childEntryFields(
  child: Pick<ChildThreadInfo, "threadId" | "title" | "depth">,
): Pick<ActivityEntry, "childThreadId" | "childThreadTitle" | "childThreadDepth"> {
  return {
    childThreadId: child.threadId,
    childThreadTitle: child.title,
    childThreadDepth: child.depth,
  };
}
