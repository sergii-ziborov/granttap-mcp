/**
 * The Project's Mesh as a map a model or a person can read in one pass.
 *
 * `weavatrix-md` showed the value of a small deterministic markdown map next
 * to the code: nothing to query, nothing to learn, just read. The same is
 * done for the Mesh — the Tasks alive in a Project, who is editing which
 * module, the other side of each repository, what waits on what, and what
 * just happened — as text. The brief is the few lines of it that matter to
 * one Task right now; the map is the whole Project.
 */
import type { MeshSnapshot } from "../../../../packages/protocol/schema";
import { compactText } from "./journal";
import { executionRepository, otherSide } from "./other-side";
import { scopedNeighbours } from "./scoped-view";
import { moduleRoot } from "./store-support";

const MAX_MAP_TASKS = 32;
const MAX_MAP_EVENTS = 12;

function repositoryName(repositoryId: string | undefined, snapshot: MeshSnapshot): string | undefined {
  if (!repositoryId) return undefined;
  const binding = (snapshot.bindings ?? []).find((item) => item.repositoryId === repositoryId);
  if (binding?.displayName) return binding.displayName;
  return repositoryId.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") || repositoryId;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

function eventLine(event: MeshSnapshot["events"][number]): string | undefined {
  const text = event.payload.summary ?? event.payload.question ?? event.payload.answer ?? event.payload.reason;
  if (!text) return undefined;
  const label = event.eventType.toLowerCase().replace(/_/g, " ");
  return `${label}: ${compactText(text, 200)}`;
}

/** A Task's title as one short phrase: a title minted from a first message can be a paragraph. */
function taskTitle(snapshot: MeshSnapshot, taskId: string): string {
  return compactText(snapshot.tasks.find((task) => task.taskId === taskId)?.title ?? taskId, 80);
}

/** An open execution is live when its chat did something within the hour. */
export const LIVE_WINDOW_MS = 60 * 60_000;

function isLive(execution: MeshSnapshot["executions"][number], now: number): boolean {
  // A computer that predates `activeAt` still says when it last observed the
  // execution; a record nobody has touched in an hour is not live either way.
  const reference = execution.activeAt ?? execution.updatedAt ?? execution.startedAt;
  return execution.endedAt == null && now - reference <= LIVE_WINDOW_MS;
}

/** Where a Task is being worked right now: its live executions. */
function liveWork(snapshot: MeshSnapshot, taskId: string, now = Date.now()): MeshSnapshot["executions"] {
  return snapshot.executions.filter((item) => item.taskId === taskId && isLive(item, now));
}

/** Open but quiet: the chat exists and has not done anything for an hour. */
function idleWork(snapshot: MeshSnapshot, taskId: string, now = Date.now()): MeshSnapshot["executions"] {
  return snapshot.executions.filter((item) => item.taskId === taskId && item.endedAt == null && !isLive(item, now));
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The whole Project as markdown. */
export function meshMap(snapshot: MeshSnapshot, now = Date.now()): string {
  const lines: string[] = [];
  const live = snapshot.executions.filter((item) => isLive(item, now));
  const idle = snapshot.executions.filter((item) => item.endedAt == null && !isLive(item, now));
  lines.push(`# Project Mesh — ${snapshot.project.name}`);
  lines.push("");
  lines.push(`_${snapshot.tasks.length} Task${snapshot.tasks.length === 1 ? "" : "s"} · ${live.length} live execution${live.length === 1 ? "" : "s"}${idle.length ? ` · ${idle.length} idle` : ""} · ${new Date(now).toISOString()}_`);

  lines.push("", "## Tasks", "");
  const tasks = [...snapshot.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_MAP_TASKS);
  if (tasks.length === 0) lines.push("- (none)");
  for (const task of tasks) {
    const work = liveWork(snapshot, task.taskId, now).map((item) => {
      const repository = repositoryName(executionRepository(item, snapshot), snapshot);
      const when = item.activeAt != null ? `, active ${ago(item.activeAt, now)}` : "";
      return `${item.provider} on ${item.computerId}${repository ? ` in ${repository}` : ""}${when}`;
    });
    const quiet = idleWork(snapshot, task.taskId, now);
    const idleNote = work.length === 0 && quiet.length > 0
      ? `; idle${quiet[0]?.activeAt != null ? ` since ${ago(quiet[0].activeAt, now)}` : ""}`
      : "";
    const latest = [...snapshot.events].reverse().find((event) => event.taskId === task.taskId && eventLine(event));
    const tail = latest ? ` — ${eventLine(latest)}` : "";
    lines.push(`- **${taskTitle(snapshot, task.taskId)}** — ${task.state}${work.length ? `; ${work.join(", ")}` : idleNote}${tail}`);
  }

  const byModule = new Map<string, string[]>();
  for (const claim of snapshot.claims) {
    const module = moduleRoot(claim.resource) || "(top level)";
    const how = claim.mode === "intent" ? "seen editing" : "claimed";
    const entry = `${taskTitle(snapshot, claim.taskId)} (${how} ${claim.resource})`;
    byModule.set(module, [...(byModule.get(module) ?? []), entry]);
  }
  lines.push("", "## Editing now", "");
  if (byModule.size === 0) lines.push("- (nothing claimed)");
  for (const [module, entries] of [...byModule.entries()].sort()) {
    lines.push(`- \`${module}\`: ${entries.join("; ")}`);
  }

  lines.push("", "## Other side", "");
  const peers = snapshot.peers ?? [];
  if (peers.length === 0) lines.push("- (no integration map; commit a WEAVATRIX.md to a bound repository)");
  for (const peer of peers) {
    const through = peer.through ? ` ${peer.through}` : "";
    const working = snapshot.tasks
      .filter((task) => otherSide(snapshot, task.taskId).some((row) => row.statedBy === peer.repositoryId && row.through === peer.through))
      .map((task) => taskTitle(snapshot, task.taskId));
    const note = working.length ? ` — ${working.join(", ")} working across it` : "";
    lines.push(`- ${repositoryName(peer.repositoryId, snapshot)} ${peer.relation.replace("_", " ")}${through} → ${peer.peer} (${peer.via})${note}`);
  }

  lines.push("", "## Dependencies", "");
  if (snapshot.dependencies.length === 0) lines.push("- (none)");
  for (const dependency of snapshot.dependencies) {
    lines.push(`- ${taskTitle(snapshot, dependency.taskId)} waits for ${taskTitle(snapshot, dependency.dependsOnTaskId)}`);
  }

  lines.push("", "## Recent", "");
  const recent = [...snapshot.events]
    .filter((event) => eventLine(event))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_MAP_EVENTS);
  if (recent.length === 0) lines.push("- (quiet)");
  for (const event of recent) {
    lines.push(`- ${clock(event.createdAt)} ${taskTitle(snapshot, event.taskId)} — ${eventLine(event)}`);
  }
  return lines.join("\n") + "\n";
}

/** The lines of the map that matter to one Task right now; empty when nothing does. */
export function meshBrief(snapshot: MeshSnapshot, taskId: string, now = Date.now()): string[] {
  const lines: string[] = [];
  const others = snapshot.tasks.filter((task) =>
    task.taskId !== taskId && liveWork(snapshot, task.taskId, now).length > 0);
  const idle = snapshot.tasks.filter((task) =>
    task.taskId !== taskId && liveWork(snapshot, task.taskId, now).length === 0 && idleWork(snapshot, task.taskId, now).length > 0);
  if (others.length > 0) {
    const named = others.slice(0, 5).map((task) => {
      const execution = liveWork(snapshot, task.taskId, now)[0];
      const repository = execution ? repositoryName(executionRepository(execution, snapshot), snapshot) : undefined;
      const when = execution?.activeAt != null ? `, ${ago(execution.activeAt, now)}` : "";
      return `${taskTitle(snapshot, task.taskId)}${repository ? ` (${repository}${when})` : when ? ` (${when.slice(2)})` : ""}`;
    });
    const more = others.length > 5 ? ` (+${others.length - 5})` : "";
    const quiet = idle.length > 0 ? ` ${idle.length} other chat${idle.length === 1 ? "" : "s"} here ${idle.length === 1 ? "is" : "are"} open but idle.` : "";
    lines.push(`Also active in this Project within the hour: ${named.join("; ")}${more}.${quiet}`);
  } else if (idle.length > 0) {
    lines.push(`${idle.length} other chat${idle.length === 1 ? "" : "s"} in this Project ${idle.length === 1 ? "is" : "are"} open but idle for over an hour.`);
  }
  const neighbours = scopedNeighbours(snapshot, taskId).slice(0, 5);
  for (const { claim, kind } of neighbours) {
    lines.push(`Next to you: ${taskTitle(snapshot, claim.taskId)} is ${kind === "file" ? "editing the same file" : "working in the same module"} — ${claim.resource}.`);
  }
  for (const row of otherSide(snapshot, taskId).slice(0, 3)) {
    const through = row.through ? ` ${row.through}` : "";
    lines.push(`Other side: ${compactText(row.title, 80)} is working in ${repositoryName(row.repositoryId, snapshot)} (${repositoryName(row.statedBy, snapshot)} ${row.relation.replace("_", " ")}${through}).`);
  }
  const waiting = snapshot.events.filter((event) =>
    event.taskId === taskId && event.eventType === "AGENT_QUESTION" && event.payload.question
    && !snapshot.events.some((answer) => answer.eventType === "AGENT_ANSWER" && answer.payload.questionEventId === event.eventId));
  for (const question of waiting.slice(-2)) {
    lines.push(`Still unanswered: ${compactText(question.payload.question ?? "", 160)}`);
  }
  return lines;
}
