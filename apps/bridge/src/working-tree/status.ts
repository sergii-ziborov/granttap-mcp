/**
 * One `git status` reading of a checkout: branch, upstream distance, operation in progress and the
 * changed paths. Read-only, through the shared bounded Git pool (`readRepositoryGit`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionWorkingTree } from "../../../../packages/protocol/schema";
import { readRepositoryGit } from "../mesh/catalog/repository-inspection";

export type ChangedPath = { path: string; status: string; from?: string };
export type TreeReading = {
  root: string; branch?: string; detached: boolean; ahead?: number; behind?: number;
  operation?: SessionWorkingTree["operation"]; files: ChangedPath[]; token: string;
};

const OPERATIONS: Array<[string, NonNullable<SessionWorkingTree["operation"]>]> = [
  ["MERGE_HEAD", "merge"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"]];

/** `git status --porcelain=v2 --branch -z`: headers, then one record per path; a rename carries its origin. */
export function parseStatus(output: string): Pick<TreeReading, "branch" | "detached" | "ahead" | "behind" | "files"> {
  const records = output.split("\0");
  const files: ChangedPath[] = [];
  let branch: string | undefined, detached = false, ahead: number | undefined, behind: number | undefined;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      if (head === "(detached)") detached = true; else branch = head;
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("1 ")) {
      files.push({ status: record.slice(2, 4).replace(/\./g, " "), path: record.split(" ").slice(8).join(" ") });
    } else if (record.startsWith("2 ")) {
      files.push({ status: record.slice(2, 4).replace(/\./g, " "), path: record.split(" ").slice(9).join(" "),
        from: records[++index] });
    } else if (record.startsWith("u ")) {
      files.push({ status: record.slice(2, 4), path: record.split(" ").slice(10).join(" ") });
    } else if (record.startsWith("? ")) {
      files.push({ status: "??", path: record.slice(2) });
    }
  }
  return { branch, detached, ahead, behind, files };
}

/**
 * The checkout this folder is in and its status, or nothing when it is no checkout or Git did not answer.
 * `urgent` for a reading the phone waits for (`readRepositoryGit`).
 */
export async function readTree(folder: string, options: { urgent?: boolean } = {}): Promise<TreeReading | undefined> {
  if (!isAbsolute(folder)) return undefined;
  const urgent = options.urgent === true;
  const root = (await readRepositoryGit(folder, ["rev-parse", "--show-toplevel"], { urgent }))?.trim();
  if (!root) return undefined;
  const [status, gitDir, head] = await Promise.all([
    readRepositoryGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
      { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024, urgent }),
    readRepositoryGit(root, ["rev-parse", "--absolute-git-dir"], { urgent }),
    readRepositoryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { urgent }),
  ]);
  if (status === undefined) return undefined;
  const directory = gitDir?.trim();
  const operation = directory ? OPERATIONS.find(([name]) => existsSync(join(directory, name)))?.[1] : undefined;
  const token = createHash("sha256").update(`${head?.trim() ?? ""}\0${status}`).digest("hex");
  return { root, ...parseStatus(status), ...(operation ? { operation } : {}), token };
}

export type Worktree = { path: string; branch?: string; detached: boolean; head?: string; locked: boolean };

/** `git worktree list --porcelain -z`: one record per checkout, its attributes NUL-ended, an empty one between. */
export function parseWorktrees(output: string): Worktree[] {
  const list: Worktree[] = [];
  let current: Worktree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), detached: false, locked: false };
      list.push(current);
    } else if (!current) {
      continue;
    } else if (field.startsWith("HEAD ")) {
      const head = field.slice("HEAD ".length);
      if (/^[a-f0-9]{7,64}$/.test(head) && !/^0+$/.test(head)) current.head = head;
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field === "detached") {
      current.detached = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
    } else if (field === "bare") {
      list.pop();
      current = undefined;
    }
  }
  return list;
}

/** Every checkout of the repository this root belongs to, the main one first; nothing when Git did not answer. */
export async function readWorktrees(root: string, options: { urgent?: boolean } = {}): Promise<Worktree[] | undefined> {
  const output = await readRepositoryGit(root, ["worktree", "list", "--porcelain", "-z"],
    { timeoutMs: 5_000, urgent: options.urgent === true });
  return output === undefined ? undefined : parseWorktrees(output);
}
