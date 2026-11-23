# Recorded edits beyond the chat's own native items

Public entry: [`index.ts`](index.ts). Part of [transcript history](../README.md).

A chat's **Files** list is built from `fileChanges` on its root rows. Codex
writes completed `FileChange` items for its own turn; this module records what
was otherwise missing from that list:

- **Claude's own edits.** `claudeRecordedChanges` pairs each `Edit`, `Write`
  and `MultiEdit` call on a history page with its result. Only a result without
  `is_error` counts. The host's `structuredPatch` is the diff when its row
  answers exactly one call; otherwise the call's old and new text is, the same
  estimate the row's "+n −m" uses. The call's row carries the change.
- **What Claude's agents changed.** An `Agent` (or older `Task`) call's row
  carries every file the agent it started changed, and the files of agents
  that agent started, to 16 levels. A launch is linked to its transcript in
  `<session>/subagents/` by the `agentId` its result names, or else by the
  `toolUseId` in the `agent-*.meta.json` Claude Code writes beside it. Only the
  chat's own listed subagent transcripts are read, and only those a launch on
  the page leads to. A transcript is read once and then only what was appended
  to it.
- **What Codex's agents changed.** A Codex agent is its own rollout with no link
  to the call that started it, so a completed reply's `fileChanges` also holds
  the edits its child rollouts completed between the turn's start and the reply.
  An agent's edits during a turn that has not completed show once it has.

Each agent file names the agent: `agentThreadId` and `agentTitle` (the
description it was launched with, else the agent's first request). Every file
carries `folder`: the Git checkout it is in (a repository, or a worktree whose
`.git` is a file), the top folder that no longer exists for a removed worktree,
or else the file's own folder. Lists group by it.

Bounds are the history page's: at most 64 files per row (beyond that the row
says `fileChangesComplete: false`), diffs of at most 2 KiB per file, 128 KiB of
files per row and 384 KiB per page. Files whose names mark them as secrets are
left out, as for Codex; diffs are redacted. These are recorded edits, not a
claim about the final working tree. Older apps show the extra rows without the
new fields.

Tests in [`tests/`](tests/) use synthetic transcripts: Claude agents editing a
second worktree, a plain folder and a removed worktree, nested agents, a failed
and a secret edit, an agent still writing, the file and byte bounds, unreadable
or missing agents, and a Codex agent's edits inside and after a turn.
