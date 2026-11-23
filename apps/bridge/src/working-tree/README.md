# Working tree of a chat

Public entry: `index.ts` (`attachWorkingTrees`) and `relay.ts` (`handleWorkingTreeRequest`). The
phone shows, next to "Working now", what a chat's working folder (`worktree`, else `cwd`) has not
committed, and commits chosen paths from a sheet.

**On the session record** (`workingTree`, `packages/protocol/messages/sessions/working-tree.ts`):

```ts
workingTree?: { branch?: string; detached?: true; ahead?: number; behind?: number; changed: number;
  operation?: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect"; observedAt: number }
```

Only for a folder inside a Git checkout, from one `git status --porcelain=v2 --branch -z
--untracked-files=normal` reading of the checkout's root through the shared bounded Git pool (two
commands at a time, five-second timeout). `ahead`/`behind` come with that reading and are absent
without an upstream. Each monitor catalog attaches the newest reading and asks for a fresh one in the
background when it is five seconds old, one per folder however many chats share it, at most 64 folders,
live chats only. A commit from the phone makes the next catalog read the folder again.

**Requests** (answered only to the phone that asked, under the chat's task key):

| Request | Fields | Answer |
| --- | --- | --- |
| `session.changes.query` | `sessionId`, `requestId`, `worktree?`, `createdAt` | `session.changes.result`: `branch`, `detached`, `ahead`, `behind`, `operation`, `folder` (the listed checkout's root), `worktrees` (at most 100 of `{ path, branch?, detached?, head?, current?, locked? }`), `files` (at most 200 of `{ path, status, from? }`: paths relative to the checkout root, `status` Git's two letters such as ` M`, `M `, `A `, `D `, `R `, `UU`, `??`; `from` for a rename), `total`, `truncated`, `treeToken` (64 hex), or `unavailable: true` |
| `session.commit` | `sessionId`, `requestId`, `message` (1–2000 characters), `paths` (1–200, as listed), `treeToken`, `confirmWhileWorking?`, `createdAt` | `session.commit.result`: `ok`, `commit` (the new HEAD), or `reason`: `changed`, `detached`, `operation`, `working`, `unavailable`, `failed` with Git's first line in `detail` |

A commit is refused when the tree no longer gives the listing's `treeToken` (HEAD and status
together), a path is not among the listed changes, the branch is detached, a merge, rebase,
cherry-pick, revert or bisect is in progress, or the chat's own turn is running and the phone did
not send `confirmWhileWorking: true`. Otherwise the paths not yet staged are added (`git add -A --
<paths>`) and `git commit -m <message> -- <paths, with a rename's origin>` commits exactly them: other
staged work stays staged and out of the commit. The repository's hooks run; a hook's refusal is
`failed`. Nothing is pushed, and no option bypasses hooks or signing.

**Worktrees.** A listing names every checkout of the chat's repository from one `git worktree list
--porcelain -z`: the main one and each linked one, with its branch (or detached), the commit it has
out and whether it is locked; the chat's own is `current`. Agents often work in worktrees of their
own, so the chat's folder can show one change while the work sits beside it. `worktree` in the query,
an absolute path the listing named, lists that checkout instead: branch, upstream distance and files,
read-only, with no `treeToken`, so a commit stays with the chat's own folder. A path that is not one of
the repository's worktrees is answered `unavailable`. The schema is strict, so a computer before this
refuses the field: a phone sends it only to a computer whose listing had `worktrees`.

**The phone waits for these reads.** They go through the shared Git pool as `urgent`: ahead of the
queued catalog and working-tree readings, and into a third slot when both are busy. Before, a
listing waited behind every queued reading of every Mesh repository and folder; with slow folders
in the queue it came after the phone's ten seconds, which said "The computer did not answer."

Both answers travel in the relay queue's control lane, like a picture's chunks, ahead of catalogs,
Mesh snapshots and load reports. In 0.8.190 they waited among those replaceable snapshots: on a
computer whose upload was backed up they reached the phone after it had stopped waiting, or were
dropped for newer traffic, and the phone's sheet only spun.

Tests live in `tests/`, against real temporary repositories. `phone-round-trip.test.ts` carries a
listing and a commit from a phone-role client through a loopback relay, both encryption layers and
the monitor's routing, while the computer's upload is backed up with load reports.

Licensed under the GrantTap Commercial Source License. See the repository root `LICENSE`.
