/**
 * Why a newer runtime waits, written by the monitor that holds it so status views in other processes
 * (`connection_status`, the phone's computer status) can say so: what the wait is for, since when,
 * and when the next attempt comes. The file names its monitor; once that monitor is gone, it says
 * nothing.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const UpdateBlocker = z.object({
  kind: z.enum(["run", "answer", "approval", "sign-in", "maintenance", "command"]),
  /** For a run: the chat it runs in. */
  sessionId: z.string().min(1).max(256).optional(),
  /** For a run that starts a new task: its provider. */
  newTask: z.string().min(1).max(40).optional(),
  since: z.number().nonnegative().optional(),
  count: z.number().int().positive().optional(),
}).strict();
export type UpdateBlocker = z.infer<typeof UpdateBlocker>;

export const UpdateHold = z.object({
  version: z.string().min(1).max(80).optional(),
  /**
   * holding: new phone messages wait for `blockers` to end, until `holdUntil` at most.
   * handing-over: the update is selected and the monitor is being replaced.
   * waiting: the last hold gave up (or the update cannot be taken now); the next attempt is at `nextAttemptAt`.
   * start-check-failed: the downloaded release did not start; it is tried again at `nextAttemptAt`.
   */
  phase: z.enum(["holding", "handing-over", "waiting", "start-check-failed"]),
  since: z.number().nonnegative().optional(),
  holdUntil: z.number().nonnegative().optional(),
  nextAttemptAt: z.number().nonnegative().optional(),
  /** The runs a hold that gave up was waiting for: the next one starts once they have ended. */
  afterRunsEnd: z.boolean().optional(),
  /** Holds given up in a row for this version. */
  attempts: z.number().int().nonnegative(),
  blockers: z.array(UpdateBlocker).max(32),
  /** Runs that keep going and are taken over by the new version. */
  survivingRuns: z.number().int().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type UpdateHold = z.infer<typeof UpdateHold>;

const HoldFile = UpdateHold.extend({ monitorPid: z.number().int().positive() }).strict();

export function holdStatePath(directory: string): string {
  return join(directory, "hold.json");
}

/** The monitor's own record of its hold; `undefined` clears it. Never throws. */
export function writeHoldState(directory: string, state: UpdateHold | undefined, pid = process.pid): void {
  const path = holdStatePath(directory);
  try {
    if (!state) { rmSync(path, { force: true }); return; }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(HoldFile.parse({ ...state, monitorPid: pid }))}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch { /* A status view then shows less; the update itself is unaffected. */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The hold of the monitor that is running now, if it holds one. Reading writes nothing. */
export function readHoldState(directory: string, isAlive: (pid: number) => boolean = alive): UpdateHold | undefined {
  try {
    const parsed = HoldFile.safeParse(JSON.parse(readFileSync(holdStatePath(directory), "utf8")));
    if (!parsed.success || !isAlive(parsed.data.monitorPid)) return undefined;
    const { monitorPid: _monitor, ...hold } = parsed.data;
    return hold;
  } catch { return undefined; }
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + " UTC";

function blockerText(blocker: UpdateBlocker): string {
  switch (blocker.kind) {
    case "run": return blocker.newTask ? `a new ${blocker.newTask} task being created`
      : `a run in chat ${blocker.sessionId?.slice(0, 8) ?? "?"}${blocker.since ? ` (since ${clock(blocker.since)})` : ""}`;
    case "answer": return "an answer being sent to the phone";
    case "approval": return `${blocker.count ?? 1} approval${(blocker.count ?? 1) === 1 ? "" : "s"} waiting on the phone`;
    case "sign-in": return "a provider sign-in";
    case "maintenance": return "a computer maintenance action";
    case "command": return `${blocker.count ?? 1} phone request${(blocker.count ?? 1) === 1 ? "" : "s"} being handled`;
  }
}

/** One sentence for a status line: what the hold waits for, and when it gives way or comes back. */
export function holdSentence(hold: UpdateHold): string {
  const surviving = hold.survivingRuns > 0
    ? ` ${hold.survivingRuns} running chat${hold.survivingRuns === 1 ? " keeps" : "s keep"} going and ${hold.survivingRuns === 1 ? "is" : "are"} taken over by the new version.`
    : "";
  const waiting = hold.blockers.length ? hold.blockers.map(blockerText).join(", ") : "nothing that cannot be taken over";
  switch (hold.phase) {
    case "holding":
      return `New phone messages wait for it since ${hold.since ? clock(hold.since) : "now"}, until `
        + `${hold.holdUntil ? clock(hold.holdUntil) : "the hold ends"} at the latest; it waits for ${waiting}.${surviving}`;
    case "handing-over":
      return `It is taking over now.${surviving}`;
    case "start-check-failed":
      return `It did not start when checked; it is tried again${hold.nextAttemptAt ? ` at ${clock(hold.nextAttemptAt)}` : " later"}.`;
    case "waiting":
      return `The last wait gave up${hold.attempts > 1 ? ` (${hold.attempts} in a row)` : ""}; the next one starts`
        + `${hold.nextAttemptAt ? ` at ${clock(hold.nextAttemptAt)}${hold.afterRunsEnd ? " at the earliest" : ""}` : " later"}`
        + `${hold.afterRunsEnd ? ", once the runs it waited for have ended" : ""}.`
        + (hold.blockers.length ? ` Still going: ${waiting}.` : "") + surviving;
  }
}
