/**
 * What a live chat should know before its next turn.
 *
 * Two things happen outside a session's own context: background runs answer
 * phone messages in the same chat, and other Tasks move in the same Project.
 * Both are gathered here as a few plain lines for Claude Code's
 * `UserPromptSubmit` hook to add to the prompt — the unread journal first,
 * then the Mesh brief — so the model coordinates without being told to look.
 */
import { liveExecutionScope } from "./capability";
import { describeRun, markRunsDelivered, unreadRuns, type RunRecord } from "./journal";
import { meshBrief } from "./map";
import type { MeshSnapshot } from "../../../../packages/protocol/schema";

export const MAX_CONTEXT_CHARS = 2_400;
const MAX_RUNS_SHOWN = 5;

export type PromptContextDeps = {
  unread: (sessionId: string) => RunRecord[];
  markDelivered: (sessionId: string, at: number) => void;
  scope: (sessionId: string) => { snapshot: MeshSnapshot; taskId: string } | undefined;
};

const liveDeps: PromptContextDeps = {
  unread: unreadRuns,
  markDelivered: markRunsDelivered,
  scope: (sessionId) => {
    const scope = liveExecutionScope(sessionId);
    return scope ? { snapshot: scope.snapshot, taskId: scope.execution.taskId } : undefined;
  },
};

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

/** The text to add to the next prompt of a chat, or nothing when there is nothing new. */
export function promptContext(
  sessionId: string,
  now = Date.now(),
  deps: PromptContextDeps = liveDeps,
): string | undefined {
  if (!sessionId) return undefined;
  const lines: string[] = [];
  const runs = deps.unread(sessionId);
  if (runs.length > 0) {
    const shown = runs.slice(-MAX_RUNS_SHOWN);
    lines.push(
      `GrantTap: ${runs.length} message${runs.length === 1 ? "" : "s"} from the phone ${runs.length === 1 ? "was" : "were"} `
      + "handled in this chat by background runs since your last turn. Their turns are in the transcript but not in your context:",
    );
    shown.forEach((run, index) => {
      lines.push(`${index + 1}. [${clock(run.at)}] ${describeRun(run)}`);
    });
    if (runs.length > shown.length) lines.push(`(+${runs.length - shown.length} earlier)`);
    lines.push("Continue from what they did; check the working tree before redoing or undoing it.");
  }
  const scope = deps.scope(sessionId);
  if (scope) {
    const brief = meshBrief(scope.snapshot, scope.taskId, now);
    if (brief.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`Project Mesh «${scope.snapshot.project.name}»:`, ...brief.map((line) => `- ${line}`));
      // Listed by name, not by token: Claude Code reads only listed resources,
      // and the server finds the chat from its own environment.
      lines.push("Full map: read the granttap MCP resource granttap://mesh/map");
    }
  }
  if (lines.length === 0) return undefined;
  if (runs.length > 0) deps.markDelivered(sessionId, now);
  const text = lines.join("\n");
  return text.length <= MAX_CONTEXT_CHARS ? text : `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}
