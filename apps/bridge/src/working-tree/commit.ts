/**
 * Commit exactly the paths a phone showed. Refused when the tree is no longer the listing the phone
 * saw, a path is not among its changes, the branch is detached, a merge or rebase is in progress, or
 * the chat's own turn is running and the phone did not confirm. `git add -A -- <unstaged paths>` then
 * `git commit -m <message> -- <paths>`: other staged work stays staged and out of the commit, the
 * repository's hooks run, nothing is pushed.
 */
import { execFile } from "node:child_process";
import type { SessionCommit, SessionCommitResult, SessionInfo } from "../../../../packages/protocol/schema";
import { readTree } from "./status";

type Outcome = Pick<SessionCommitResult, "ok" | "reason" | "commit" | "detail">;
export type GitWrite = (root: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

const gitWrite: GitWrite = (root, args) => new Promise((resolve) => {
  execFile("git", ["-C", root, ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout ?? ""}${stderr ?? ""}` }));
});

function firstLine(output: string): string | undefined {
  return output.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 500);
}

export async function commitChosenPaths(session: SessionInfo, folder: string, request: SessionCommit,
  write: GitWrite = gitWrite): Promise<Outcome> {
  if (session.state === "working" && request.confirmWhileWorking !== true) return { ok: false, reason: "working" };
  const tree = await readTree(folder);
  if (!tree) return { ok: false, reason: "unavailable" };
  if (tree.detached) return { ok: false, reason: "detached" };
  if (tree.operation) return { ok: false, reason: "operation" };
  if (tree.token !== request.treeToken) return { ok: false, reason: "changed" };
  const listed = new Map(tree.files.map((file) => [file.path, file]));
  const chosen = [...new Set(request.paths)];
  if (chosen.some((path) => !listed.has(path))) return { ok: false, reason: "changed" };
  // A rename is committed with the path it came from, or Git would keep the old one.
  const paths = [...new Set(chosen.flatMap((path) => [path, ...(listed.get(path)!.from ? [listed.get(path)!.from!] : [])]))];
  // Only what the working tree holds beyond the index is added; a staged rename's or removal's path
  // is in neither, and `git add` would refuse it.
  const unstaged = chosen.filter((path) => listed.get(path)!.status[1] !== " ");
  const added = unstaged.length ? await write(tree.root, ["add", "-A", "--", ...unstaged]) : { ok: true, output: "" };
  if (!added.ok) return { ok: false, reason: "failed", detail: firstLine(added.output) };
  const committed = await write(tree.root, ["commit", "-m", request.message, "--", ...paths]);
  if (!committed.ok) return { ok: false, reason: "failed", detail: firstLine(committed.output) };
  const head = await write(tree.root, ["rev-parse", "HEAD"]);
  const commit = head.output.trim();
  return { ok: true, ...(/^[a-f0-9]{40,64}$/.test(commit) ? { commit } : {}) };
}
