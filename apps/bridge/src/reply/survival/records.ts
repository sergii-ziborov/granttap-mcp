/**
 * A provider run's folder: what the run is, and the files its output goes to, so a monitor that
 * starts later can find a run that outlived the one that started it.
 *
 * `<config>/runs/<runId>/run.json` holds the record; `stdout` and `stderr` are the run's own output
 * files. The prompt reaches the process through `stdin`, which is unlinked as soon as the process
 * has it open. A record is taken by renaming it, so exactly one monitor delivers a run's answer.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../../config/runtime/paths";

export const RunParser = z.object({
  kind: z.enum(["claude", "claude-new", "codex", "grok"]),
  sessionId: z.string().min(1).max(256).optional(),
}).strict();
export type RunParser = z.infer<typeof RunParser>;

export const RunContinuation = z.object({ kind: z.string().min(1).max(40), data: z.unknown() }).strict();
export type RunContinuation = z.infer<typeof RunContinuation>;

export const RunRecord = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^[0-9a-f-]{36}$/),
  pid: z.number().int().positive(),
  /** The process's start time as the system reports it, so a reused pid is never taken for the run. */
  startToken: z.string().min(1).max(200).optional(),
  ownerPid: z.number().int().positive(),
  ownerStartToken: z.string().min(1).max(200).optional(),
  /** The in-flight key the run holds: its chat, or its new task. */
  key: z.string().min(1).max(512),
  /** The key a pause from the phone stops it by. */
  abortKey: z.string().min(1).max(512).optional(),
  command: z.string().min(1).max(4_096),
  parser: RunParser,
  startedAt: z.number().nonnegative(),
  deadline: z.number().nonnegative(),
  /** The provider confirmed it took the prompt (always, for providers without an admission step). */
  admitted: z.boolean(),
  /** The phone message counts as delivered; only its answer is owed. */
  late: z.boolean(),
  continuation: RunContinuation.optional(),
  exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable() }).strict().optional(),
}).strict();
export type RunRecord = z.infer<typeof RunRecord>;

const RECORD = "run.json";
const TAKEN = "taken.json";

export function runsRoot(): string {
  return join(configDir(), "runs");
}

export function runFolder(runId: string, root = runsRoot()): string {
  return join(root, runId);
}

export function writeRunRecord(record: RunRecord, root = runsRoot()): void {
  const folder = runFolder(record.runId, root);
  const path = join(folder, RECORD), temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(RunRecord.parse(record))}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readRunRecord(runId: string, root = runsRoot()): RunRecord | undefined {
  try {
    const parsed = RunRecord.safeParse(JSON.parse(readFileSync(join(runFolder(runId, root), RECORD), "utf8")));
    return parsed.success && parsed.data.runId === runId ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Every run on record that no monitor has taken yet. */
export function runRecords(root = runsRoot()): RunRecord[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter(name => /^[0-9a-f-]{36}$/.test(name)).flatMap(name => readRunRecord(name, root) ?? []);
}

/** Take a run's record for delivery. Exactly one caller succeeds. */
export function takeRunRecord(runId: string, root = runsRoot()): boolean {
  try { renameSync(join(runFolder(runId, root), RECORD), join(runFolder(runId, root), TAKEN)); return true; }
  catch { return false; }
}

export function removeRun(runId: string, root = runsRoot()): void {
  rmSync(runFolder(runId, root), { recursive: true, force: true });
}

/** A run folder of its own, private to this account. */
export function makeRunFolder(runId: string, root = runsRoot()): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const folder = runFolder(runId, root);
  mkdirSync(folder, { mode: 0o700 });
  return folder;
}

/** When the process started, as the system reports it; undefined when it is gone or cannot be read. */
export function processStartToken(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\)\s+/s, "").split(" ")[19];
    }
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 }).trim();
    return started || undefined;
  } catch { return undefined; }
}

let own: { token?: string } | undefined;
/** This process's own start token, read once. */
export function ownStartToken(): string | undefined {
  own ??= { token: processStartToken(process.pid) };
  return own.token;
}

/** Whether the process is still the one recorded: alive, this account's, and started when it was. */
export function processAlive(pid: number, startToken?: string): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  return startToken === undefined || processStartToken(pid) === startToken;
}
