/**
 * The folders a chat started another provider's headless runs in, read from its commands.
 *
 * A script that builds each request from a file (`prompts.json`, a queue) leaves no request in the
 * chat's command, but the command still names the folder the runs work in: `-C /tmp/art`, `cd /tmp/art`,
 * or a script it writes there (`/tmp/art/one.sh`). A chat keeps, per folder and provider, when it first
 * started that provider naming the folder and when a command last named it. Only these are kept, at
 * most `MAX_LAUNCHES` per chat, so a launch long out of the last 32 commands still counts.
 */
import { homedir } from "node:os";
import { isTempRoot, plainFolder } from "../../helper-runs/kinds";
import type { LineageAgent } from "../headless";

/** A folder a chat named in a command that started `agent` headless. */
export type FolderLaunch = {
  folder: string;
  agent: LineageAgent;
  /** The first such command. */
  firstAt: number;
  /** The last command of the chat that named the folder or a path inside it, whatever it ran. */
  lastAt: number;
};

const MAX_LAUNCHES = 32;
const MAX_FOLDERS_PER_COMMAND = 16;
export const MAX_FOLDER_CHARS = 512;

/** An absolute path, from home (`~`, `$HOME`) or the root, not the tail of a relative one or a URL. */
const PATH = /(?<![A-Za-z0-9._~$}/-])(~|\$HOME|\$\{HOME\})?((?:\/[A-Za-z0-9._@%+~-]+)+)/g;
/** Folders no run works in: the system's own. */
const SYSTEM = /^\/(?:dev|usr|bin|sbin|etc|opt|System|Library|Applications|proc|sys|nix|private\/etc)(?:\/|$)/;
const FILE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Whether a folder is too broad to be one batch's: the root, a temp directory itself, the home
 * folder or one above it.
 */
export function broadFolder(folder: string, home = homedir()): boolean {
  const own = plainFolder(home);
  return folder.split("/").filter(Boolean).length < 2 || isTempRoot(folder) || folder === own
    || own.startsWith(`${folder}/`);
}

/**
 * Every folder a command names: an absolute path as it is, or for a file (`/tmp/art/one.sh`) the
 * folder it is in. The system's folders and ones too broad for one batch are left out.
 */
export function namedFolders(command: string, home = homedir()): string[] {
  const found = new Set<string>();
  const text = command.slice(0, 16_384);
  for (const match of text.matchAll(PATH)) {
    // A sentence's full stop is not part of the path.
    const path = plainFolder(`${match[1] ? home : ""}${match[2]!.replace(/\.+$/, "")}`);
    const parts = path.split("/");
    if (parts.some((part) => part === "." || part === "..")) continue;
    // A path that runs on into a variable or a pattern (`/tmp/art/log/run-${n}.log`) names the folder its last part is in.
    const partial = /[${*?[]/.test(text[match.index + match[0].length] ?? "");
    const folder = partial || FILE.test(parts.at(-1) ?? "") ? parts.slice(0, -1).join("/") : path;
    if (!folder || folder.length > MAX_FOLDER_CHARS || SYSTEM.test(folder) || broadFolder(folder, home)) continue;
    found.add(folder);
    if (found.size >= MAX_FOLDERS_PER_COMMAND) break;
  }
  return [...found];
}

/** One chat's launches, as its transcript is read row by row. */
export function createFolderLaunches() {
  const launches = new Map<string, FolderLaunch>();
  return {
    /** A command the chat ran at `at`, and the providers it starts headless. */
    note(command: string, targets: readonly LineageAgent[], at: number): void {
      if (targets.length === 0 && launches.size === 0) return;
      const folders = namedFolders(command);
      if (folders.length === 0) return;
      for (const launch of launches.values()) {
        if (folders.some((folder) => folder === launch.folder || folder.startsWith(`${launch.folder}/`))) {
          launch.lastAt = Math.max(launch.lastAt, at);
        }
      }
      for (const agent of targets) {
        for (const folder of folders) {
          const key = `${agent}\0${folder}`;
          const known = launches.get(key);
          if (known) known.firstAt = Math.min(known.firstAt, at);
          else launches.set(key, { folder, agent, firstAt: at, lastAt: at });
        }
      }
      // The folder named longest ago is let go first.
      while (launches.size > MAX_LAUNCHES) {
        const oldest = [...launches.entries()].reduce((left, right) => right[1].lastAt < left[1].lastAt ? right : left);
        launches.delete(oldest[0]);
      }
    },
    snapshot(): FolderLaunch[] {
      return [...launches.values()].map((launch) => ({ ...launch })).sort((left, right) => left.firstAt - right.firstAt);
    },
  };
}
