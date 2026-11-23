import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { SessionInfo as SessionSchema } from "../../../../../packages/protocol/schema";
import { attachWorkingTrees, forgetWorkingTrees, readFolder } from "..";
import { commitChanges, listChanges } from "../relay";
import { parseStatus, parseWorktrees } from "../status";

function repository(t: TestContext): { root: string; git: (...args: string[]) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "granttap-working-tree-")));
  t.after(() => { forgetWorkingTrees(); rmSync(root, { recursive: true, force: true }); });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "kept.txt"), "one\n"); writeFileSync(join(root, "old-name.txt"), "rename me\n");
  writeFileSync(join(root, "staged-elsewhere.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "base");
  return { root, git };
}

const chat = (cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId: "commit-chat-01", agent: "codex", cwd,
  state: "idle", startedAt: 1, lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0, ...extra });
const ask = { type: "session.changes.query" as const, sessionId: "commit-chat-01", requestId: "list-1", createdAt: 1 };

test("Git's porcelain status reads as paths with their two letters, renames with their origin", () => {
  const parsed = parseStatus(["# branch.oid abc", "# branch.head feature/x", "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa aaa src/a file.ts", "2 R. N... 100644 100644 100644 aaa aaa R100 new.ts", "old.ts",
    "u UU N... 100644 100644 100644 100644 a b c both.ts", "? notes.md", ""].join("\0"));
  assert.deepEqual(parsed, { branch: "feature/x", detached: false, ahead: 2, behind: 1, files: [
    { status: " M", path: "src/a file.ts" }, { status: "R ", path: "new.ts", from: "old.ts" },
    { status: "UU", path: "both.ts" }, { status: "??", path: "notes.md" }] });
  assert.equal(parseStatus("# branch.head (detached)\0").detached, true);
});

test("Git's worktree list reads as checkouts with their branch, commit and lock; a bare repository is left out", () => {
  const head = "a".repeat(40);
  assert.deepEqual(parseWorktrees([`worktree /repo`, `HEAD ${head}`, "branch refs/heads/main", "",
    `worktree /repo-agent`, `HEAD ${head}`, "detached", "locked reason", "", "worktree /bare.git", "bare", "", ""].join("\0")), [
    { path: "/repo", head, branch: "main", detached: false, locked: false },
    { path: "/repo-agent", head, detached: true, locked: true }]);
});

test("the phone sees every worktree of the chat's repository and lists another one read-only", async (t) => {
  const { root, git } = repository(t);
  const linked = `${root}-agent`;
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git("worktree", "add", "-q", "-b", "agent/work", linked);
  writeFileSync(join(root, "kept.txt"), "two\n");
  writeFileSync(join(linked, "agent.txt"), "made by an agent\n"); writeFileSync(join(linked, "kept.txt"), "three\n");

  const own = await listChanges(chat(root), ask);
  assert.equal(own.folder, root);
  assert.equal(own.total, 1);
  assert.ok(own.treeToken, "the chat's own checkout can be committed");
  assert.deepEqual(own.worktrees?.map((tree) => [tree.path, tree.branch, tree.current === true]),
    [[root, "main", true], [realpathSync(linked), "agent/work", false]]);

  const other = await listChanges(chat(root), { ...ask, requestId: "list-2", worktree: linked });
  assert.equal(other.folder, realpathSync(linked));
  assert.equal(other.branch, "agent/work");
  assert.deepEqual(other.files.map((file) => file.path).sort(), ["agent.txt", "kept.txt"]);
  assert.equal(other.treeToken, undefined, "another checkout is listed read-only");
  assert.equal(other.worktrees?.find((tree) => tree.current)?.path, root);

  const stranger = await listChanges(chat(root), { ...ask, requestId: "list-3", worktree: "/tmp" });
  assert.equal(stranger.unavailable, true, "only a worktree of the chat's repository is read");
});

test("a chat's card carries its folder's uncommitted count, read in the background and shared per folder", async (t) => {
  const { root } = repository(t);
  writeFileSync(join(root, "kept.txt"), "two\n"); writeFileSync(join(root, "new.txt"), "new\n");
  const first = attachWorkingTrees([chat(root), chat(root, { sessionId: "second-chat-01" }), chat("/nowhere-at-all")]);
  assert.equal(first[0]!.workingTree, undefined, "nothing read yet; the read starts now");
  await readFolder(root);
  const [card, sibling, elsewhere] = attachWorkingTrees([chat(root), chat(root, { sessionId: "second-chat-01" }), chat("/nowhere-at-all")]);
  assert.deepEqual({ ...card!.workingTree, observedAt: 0 }, { branch: "main", changed: 2, observedAt: 0 });
  assert.equal(sibling!.workingTree?.changed, 2);
  assert.equal(elsewhere!.workingTree, undefined);
  assert.ok(SessionSchema.parse(card).workingTree);
});

test("the phone commits exactly the paths it showed, and nothing else that was staged", async (t) => {
  const { root, git } = repository(t);
  writeFileSync(join(root, "kept.txt"), "two\n"); writeFileSync(join(root, "added.txt"), "new\n");
  renameSync(join(root, "old-name.txt"), join(root, "new-name.txt")); git("add", "-A", "old-name.txt", "new-name.txt");
  writeFileSync(join(root, "staged-elsewhere.txt"), "staged by someone\n"); git("add", "staged-elsewhere.txt");
  const listing = await listChanges(chat(root), ask);
  assert.deepEqual(listing.files.map((file) => [file.status, file.path, file.from]).sort(), [
    [" M", "kept.txt", undefined], ["??", "added.txt", undefined], ["M ", "staged-elsewhere.txt", undefined],
    ["R ", "new-name.txt", "old-name.txt"]]);
  assert.equal(listing.total, 4);
  const commit = { type: "session.commit" as const, sessionId: "commit-chat-01", requestId: "commit-1", message: "Keep the new notes",
    paths: ["kept.txt", "added.txt", "new-name.txt"], treeToken: listing.treeToken!, createdAt: 2 };
  assert.equal((await commitChanges(chat(root, { state: "working" }), commit)).reason, "working");
  assert.equal((await commitChanges(chat(root), { ...commit, paths: ["not-changed.txt"] })).reason, "changed");
  const done = await commitChanges(chat(root, { state: "working" }), { ...commit, confirmWhileWorking: true });
  assert.equal(done.ok, true);
  assert.match(done.commit!, /^[a-f0-9]{40}$/);
  assert.deepEqual(git("show", "--name-status", "--format=%s", "HEAD").trim().split("\n").filter(Boolean),
    ["Keep the new notes", "A\tadded.txt", "M\tkept.txt", "R100\told-name.txt\tnew-name.txt"]);
  assert.equal(git("status", "--porcelain").trim(), "M  staged-elsewhere.txt");
  assert.equal((await commitChanges(chat(root), commit)).reason, "changed", "the tree moved on since that listing");
});

test("a commit is refused on a detached branch, during a merge, and Git's own refusal is reported", async (t) => {
  const { root, git } = repository(t);
  writeFileSync(join(root, "kept.txt"), "two\n");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n"); chmodSync(hook, 0o755);
  let listing = await listChanges(chat(root), ask);
  const commit = { type: "session.commit" as const, sessionId: "commit-chat-01", requestId: "commit-2", message: "Try",
    paths: ["kept.txt"], treeToken: listing.treeToken!, createdAt: 2 };
  assert.deepEqual(await commitChanges(chat(root), commit).then((result) => [result.ok, result.reason, result.detail]),
    [false, "failed", "hook says no"]);
  rmSync(hook);
  writeFileSync(join(root, ".git", "MERGE_HEAD"), git("rev-parse", "HEAD"));
  listing = await listChanges(chat(root), ask);
  assert.equal(listing.operation, "merge");
  assert.equal((await commitChanges(chat(root), { ...commit, treeToken: listing.treeToken! })).reason, "operation");
  rmSync(join(root, ".git", "MERGE_HEAD"));
  git("checkout", "-q", "--detach");
  listing = await listChanges(chat(root), ask);
  assert.equal(listing.detached, true);
  assert.equal((await commitChanges(chat(root), { ...commit, treeToken: listing.treeToken! })).reason, "detached");
  assert.equal((await listChanges(undefined, ask)).unavailable, true);
  assert.equal((await commitChanges(undefined, commit)).reason, "unavailable");
});
