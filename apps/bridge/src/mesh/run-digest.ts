/**
 * Turning one finished delivery into a journal entry and a Mesh event.
 *
 * The monitor knows when a run started and ended, what was asked and what came
 * back. The transcript scan knows what the run did in between: the tool calls
 * it made and the files it wrote. Put together, that is the digest a live
 * session reads on its next prompt and the Task carries as progress.
 */
import { randomUUID } from "node:crypto";
import type { MeshEvent, SessionInfo } from "../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../config";
import { scanSessionActivity } from "../sessions";
import { stripAttachmentNote } from "../sessions/activity-helpers";
import type { ReplyResult } from "../reply/types";
import { liveExecutionScope } from "./capability";
import { describeRun, recordRun, type RunRecord } from "./journal";
import { localMeshStore } from "./local";
import { repositoryRelative } from "./observed-claims";
import { recentObservedWrites } from "./observed-writes";

/** Slack around the run window: transcript timestamps and ours are not the same clock. */
const WINDOW_SLACK_MS = 2_000;

export type RunDigestDeps = {
  activity: (session: SessionInfo) => { entries: Array<{ createdAt: number; toolName?: string; kind: string }> };
  writes: (sessionId: string, now: number) => Array<{ path: string; at: number }>;
  scope: typeof liveExecutionScope;
  store: typeof localMeshStore;
  meshEnabled: () => boolean;
  now: () => number;
  eventId: () => string;
};

const liveDeps: RunDigestDeps = {
  activity: (session) => scanSessionActivity(session),
  writes: recentObservedWrites,
  scope: liveExecutionScope,
  store: localMeshStore,
  meshEnabled: () => loadRuntimeConfig().meshEnabled,
  now: () => Date.now(),
  eventId: () => randomUUID(),
};

/** What one run did, from the transcript and the writes seen during it. */
export function digestRun(
  session: SessionInfo,
  startedAt: number,
  endedAt: number,
  deps: Pick<RunDigestDeps, "activity" | "writes">,
): { tools: number; files: string[] } {
  const from = startedAt - WINDOW_SLACK_MS;
  const to = endedAt + WINDOW_SLACK_MS;
  let tools = 0;
  try {
    for (const entry of deps.activity(session).entries) {
      if (entry.createdAt >= from && entry.createdAt <= to && (entry.toolName || entry.kind === "tool")) tools += 1;
    }
  } catch {
    // A transcript that cannot be read leaves the count at zero.
  }
  const files = deps.writes(session.sessionId, endedAt)
    .filter((write) => write.at >= from && write.at <= to)
    .flatMap((write) => {
      const path = session.cwd ? repositoryRelative(write.path, session.cwd) : write.path;
      return path ? [path] : [];
    })
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort();
  return { tools, files };
}

/**
 * Journal a finished delivery and, when the chat belongs to a Mesh Task, say
 * so as that Task's progress. Never throws: the reply to the phone comes first.
 */
export function noteDeliveredRun(
  session: SessionInfo,
  prompt: string,
  result: ReplyResult,
  startedAt: number,
  endedAt: number,
  deps: RunDigestDeps = liveDeps,
): { record: RunRecord; event?: MeshEvent } | undefined {
  try {
    const { tools, files } = digestRun(session, startedAt, endedAt, deps);
    const record: RunRecord = {
      at: startedAt,
      endedAt,
      source: "phone",
      prompt: stripAttachmentNote(prompt),
      ok: result.ok,
      outcome: result.ok ? result.text : result.error,
      files,
      tools,
      cutOff: !result.ok && /did not respond within/.test(result.error) ? true : undefined,
    };
    recordRun(session.sessionId, record);
    if (!deps.meshEnabled()) return { record };
    const scope = deps.scope(session.sessionId);
    if (!scope) return { record };
    const createdAt = deps.now();
    const event: MeshEvent = {
      type: "mesh.event",
      sessionId: scope.execution.taskId,
      eventId: deps.eventId(),
      projectId: scope.snapshot.projectId,
      taskId: scope.execution.taskId,
      sourceSessionId: session.sessionId,
      eventType: "TASK_PROGRESS",
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60_000,
      payload: { summary: `Phone: ${describeRun(record)}`.slice(0, 1_000) },
    };
    return deps.store().acceptEvent(event) ? { record, event } : { record };
  } catch {
    return undefined;
  }
}
