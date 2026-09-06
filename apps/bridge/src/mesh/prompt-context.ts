/**
 * What a live chat should know before its next turn.
 *
 * Two things happen outside a session's own context: background runs answer
 * phone messages in the same chat, and other Tasks move in the same Project.
 * Both are gathered here as a few plain lines for Claude Code's
 * `UserPromptSubmit` hook to add to the prompt — the unread journal first,
 * then the Mesh brief — so the model coordinates without being told to look.
 *
 * The text is bounded, and the bound is honoured by saying less, never by
 * cutting: fewer runs, then fewer Mesh lines, then shorter run lines. The
 * Project's name and the way to the full map are always kept. A run is
 * marked read only once it was actually shown, whole or in its short form;
 * what did not fit comes on the next turn instead of vanishing.
 */
import { liveExecutionScope } from "./capability";
import {
  describeRun, markRunsDelivered, unreadRuns, type RunDescriptionLimits, type RunRecord,
} from "./journal";
import { meshBrief } from "./map";
import type { MeshSnapshot } from "../../../../packages/protocol/schema";

export const MAX_CONTEXT_CHARS = 2_400;
const MAX_RUNS_SHOWN = 5;
/** Ever shorter ways to say one run, tried in order when room is short. */
const COMPACTIONS: RunDescriptionLimits[] = [{}, { files: 3, outcome: 300 }, { files: 0, outcome: 120 }];

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

function runLines(total: number, shown: RunRecord[], limits: RunDescriptionLimits): string[] {
  if (shown.length === 0) return [];
  const lines = [
    `GrantTap: ${total} message${total === 1 ? "" : "s"} from the phone ${total === 1 ? "was" : "were"} `
    + "handled in this chat by background runs since your last turn. Their turns are in the transcript but not in your context:",
  ];
  shown.forEach((run, index) => {
    lines.push(`${index + 1}. [${clock(run.at)}] ${describeRun(run, limits)}`);
  });
  if (total > shown.length) lines.push(`(+${total - shown.length} earlier; they follow on your next turn)`);
  lines.push("Continue from what they did; check the working tree before redoing or undoing it.");
  return lines;
}

/** The Mesh part of the prompt: the Project's name and the map are the envelope, the bullets can go. */
type Brief = { head: string; bullets: string[]; map: string };

function briefLines(brief: Brief | undefined): string[] {
  return brief ? [brief.head, ...brief.bullets, brief.map] : [];
}

function compose(runs: string[], brief: Brief | undefined): string {
  const mesh = briefLines(brief);
  return [...runs, ...(runs.length > 0 && mesh.length > 0 ? [""] : []), ...mesh].join("\n");
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
  let brief: Brief | undefined;
  if (scope) {
    const lines = meshBrief(scope.snapshot, scope.taskId, now);
    if (lines.length > 0) {
      brief = {
        head: `Project Mesh «${scope.snapshot.project.name}»:`,
        bullets: lines.map((line) => `- ${line}`),
        // Listed by name, not by token: Claude Code reads only listed resources,
        // and the server finds the chat from its own environment.
        map: "Full map: read the granttap MCP resource granttap://mesh/map",
      };
    }
  }
  if (runs.length === 0 && !brief) return undefined;
  let shown = runs.slice(-MAX_RUNS_SHOWN);
  let limits = COMPACTIONS[0]!;
  let text = compose(runLines(runs.length, shown, limits), brief);
  // The newest runs first, as many as fit; then the Mesh bullets give way,
  // because they are rebuilt from the Mesh on every turn; then each run is
  // said more briefly. The envelope — the Project and the map — stays.
  while (text.length > MAX_CONTEXT_CHARS && shown.length > 1) {
    shown = shown.slice(1);
    text = compose(runLines(runs.length, shown, limits), brief);
  }
  while (text.length > MAX_CONTEXT_CHARS && brief && brief.bullets.length > 0) {
    brief = { ...brief, bullets: brief.bullets.slice(0, -1) };
    text = compose(runLines(runs.length, shown, limits), brief);
  }
  for (const compaction of COMPACTIONS.slice(1)) {
    if (text.length <= MAX_CONTEXT_CHARS) break;
    limits = compaction;
    text = compose(runLines(runs.length, shown, limits), brief);
  }
  // Bounded by construction; should a line still not fit, it is cut and the
  // run it belongs to is left unread rather than marked as told.
  const cut = text.length > MAX_CONTEXT_CHARS;
  if (cut) text = `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
  const told = cut ? shown.slice(0, -1) : shown;
  if (told.length > 0) deps.markDelivered(sessionId, now, told.map((run) => run.at));
  return text;
}
