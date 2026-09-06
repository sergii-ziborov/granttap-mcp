/**
 * What a live chat should know before its next turn.
 *
 * Two things happen outside a session's own context: background runs answer
 * phone messages in the same chat, and other Tasks move in the same Project.
 * Both are gathered here as a few plain lines for Claude Code's
 * `UserPromptSubmit` hook to add to the prompt — the unread journal first,
 * then the Mesh brief — so the model coordinates without being told to look.
 *
 * The text is bounded, and the bound is honoured by showing fewer runs, never
 * by cutting the text: a run is marked read only once it was actually shown,
 * so what did not fit this time comes on the next turn instead of vanishing.
 */
import { liveExecutionScope } from "./capability";
import { describeRun, markRunsDelivered, unreadRuns, type RunRecord } from "./journal";
import { meshBrief } from "./map";
import type { MeshSnapshot } from "../../../../packages/protocol/schema";

export const MAX_CONTEXT_CHARS = 2_400;
const MAX_RUNS_SHOWN = 5;

export type PromptContextDeps = {
  unread: (sessionId: string) => RunRecord[];
  /** Mark the runs that were shown, by their `at`; nothing else is marked. */
  markDelivered: (sessionId: string, at: number, shown: number[]) => void;
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

function runLines(total: number, shown: RunRecord[]): string[] {
  if (shown.length === 0) return [];
  const lines = [
    `GrantTap: ${total} message${total === 1 ? "" : "s"} from the phone ${total === 1 ? "was" : "were"} `
    + "handled in this chat by background runs since your last turn. Their turns are in the transcript but not in your context:",
  ];
  shown.forEach((run, index) => {
    lines.push(`${index + 1}. [${clock(run.at)}] ${describeRun(run)}`);
  });
  if (total > shown.length) lines.push(`(+${total - shown.length} earlier; they follow on your next turn)`);
  lines.push("Continue from what they did; check the working tree before redoing or undoing it.");
  return lines;
}

function compose(runs: string[], brief: string[]): string {
  return [...runs, ...(runs.length > 0 && brief.length > 0 ? [""] : []), ...brief].join("\n");
}

/** The text to add to the next prompt of a chat, or nothing when there is nothing new. */
export function promptContext(
  sessionId: string,
  now = Date.now(),
  deps: PromptContextDeps = liveDeps,
): string | undefined {
  if (!sessionId) return undefined;
  const runs = deps.unread(sessionId);
  const scope = deps.scope(sessionId);
  let brief: string[] = [];
  if (scope) {
    const lines = meshBrief(scope.snapshot, scope.taskId, now);
    if (lines.length > 0) {
      brief = [
        `Project Mesh «${scope.snapshot.project.name}»:`,
        ...lines.map((line) => `- ${line}`),
        // Listed by name, not by token: Claude Code reads only listed resources,
        // and the server finds the chat from its own environment.
        "Full map: read the granttap MCP resource granttap://mesh/map",
      ];
    }
  }
  if (runs.length === 0 && brief.length === 0) return undefined;
  // The newest runs first, as many as fit; then the brief gives way, one line
  // at a time, because it is rebuilt from the Mesh on every turn anyway.
  let shown = runs.slice(-MAX_RUNS_SHOWN);
  let text = compose(runLines(runs.length, shown), brief);
  while (text.length > MAX_CONTEXT_CHARS && shown.length > 1) {
    shown = shown.slice(1);
    text = compose(runLines(runs.length, shown), brief);
  }
  while (text.length > MAX_CONTEXT_CHARS && brief.length > 2) {
    brief = [...brief.slice(0, -2), brief[brief.length - 1]!];
    text = compose(runLines(runs.length, shown), brief);
  }
  if (text.length > MAX_CONTEXT_CHARS) text = `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
  if (shown.length > 0) deps.markDelivered(sessionId, now, shown.map((run) => run.at));
  return text;
}
