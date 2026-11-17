/**
 * Link a headless run to the one chat that started its provider in the run's own folder.
 *
 * A chat that writes a script per batch (`one.sh <index>` reading `prompts.json`, a Python loop over a
 * queue) leaves no request in its commands, so the request cannot be found there. The folder the runs
 * work in still says whose they are when it is a folder made for them: no checkout of its own, not
 * inside one, or gone; and when exactly one chat on this computer started that provider headless in a
 * command naming it. A run that started from that chat's first such command until `FOLDER_WINDOW_MS`
 * after the chat last named the folder is that chat's. A folder two chats named links nothing.
 */
import { existsSync } from "node:fs";
import { insideCheckout, plainFolder } from "../../helper-runs/kinds";
import type { LineageFact } from "../facts";
import type { StartedBy } from "../links";

export { broadFolder, createFolderLaunches, namedFolders, type FolderLaunch } from "./launches";

/** A detached batch runs on after its chat went quiet: hours, waiting out a usage limit. */
export const FOLDER_WINDOW_MS = 12 * 60 * 60_000;
/** The first run can start just before the command that named its folder was written down. */
const BEFORE_MS = 3_000;

const CHECK_AGAIN_MS = 60_000;
const checks = new Map<string, { at: number; own: boolean }>();

/**
 * Whether runs were made to work in a folder: it is gone, or it holds no checkout and lies in none.
 * Asked once a minute per folder; hundreds of runs share one.
 */
export function runFolder(folder: string, now = Date.now()): boolean {
  const known = checks.get(folder);
  if (known && now - known.at < CHECK_AGAIN_MS && now >= known.at) return known.own;
  let own = false;
  try {
    own = !existsSync(folder) || (!existsSync(`${folder}/.git`) && !insideCheckout(folder));
  } catch {
    // A folder that cannot be looked at is not called a run's.
  }
  if (checks.size >= 4_096) checks.clear();
  checks.set(folder, { at: now, own });
  return own;
}

/** For tests: look at every folder again. */
export function forgetRunFolders(): void {
  checks.clear();
}

type Launcher = { parent: LineageFact; firstAt: number; lastAt: number };

/** The chat each child was started by, as its folder tells, or none. */
export function folderParents(
  facts: readonly LineageFact[],
  now = Date.now(),
  isRunFolder: (folder: string, now: number) => boolean = runFolder,
): (child: LineageFact) => StartedBy | undefined {
  const named = new Map<string, Launcher[]>();
  for (const parent of facts) {
    if (parent.computerId) continue;
    for (const launch of parent.launches ?? []) {
      const key = `${launch.agent}\0${launch.folder}`;
      const launchers = named.get(key) ?? [];
      launchers.push({ parent, firstAt: launch.firstAt, lastAt: launch.lastAt });
      named.set(key, launchers);
    }
  }
  if (named.size === 0) return () => undefined;
  return (child) => {
    if (!child.headless || !child.cwd || child.computerId) return undefined;
    const folder = plainFolder(child.cwd);
    const launchers = (named.get(`${child.agent}\0${folder}`) ?? [])
      .filter(({ parent }) => parent.agent !== child.agent || parent.sessionId !== child.sessionId);
    if (new Set(launchers.map(({ parent }) => `${parent.agent}\0${parent.sessionId}`)).size !== 1) return undefined;
    const { parent, firstAt, lastAt } = launchers[0]!;
    if (parent.startedAt > child.startedAt || child.startedAt < firstAt - BEFORE_MS
      || child.startedAt > lastAt + FOLDER_WINDOW_MS || !isRunFolder(folder, now)) return undefined;
    return { agent: parent.agent, sessionId: parent.sessionId };
  };
}
