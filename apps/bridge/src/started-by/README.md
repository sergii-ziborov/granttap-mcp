# Chats started by another chat

A chat can start another provider's chat from its shell: Claude Code running
`codex exec "…"` to make a picture, Codex running `claude -p`, either running
`grok -p`. Each such run is a chat in its own right, with its own transcript,
and the phone draws it under the chat that started it. This module learns that
relationship and publishes it on the child's session record:

```ts
startedBy?: { agent: "claude" | "codex" | "grok" | "cursor"; sessionId: string }
```

`agent` and `sessionId` name the parent chat as the parent's provider knows it.
The parent may be on another computer or gone; the field is still published and
the phone decides how to show it. A short helper run in a folder made for it
(see [helper runs](../helper-runs/README.md)) stays one of its chat's nested
conversations in `childThreads`, not a chat with `startedBy`.

**What is a child** (`headless.ts`). Only a session started headless: `codex
exec` (`originator: codex_exec` in its rollout), `claude -p`/`--print` or the
SDK's stream-json input (`entrypoint: sdk-*` in its transcript), a headless Grok
session. A run that resumes an earlier chat (`codex exec resume`, `claude -p
--resume`) starts none. An interactive session is never a child, even when its
environment carries a chat's id: a terminal or tmux started from a chat's shell
hands that id to everything typed in it for as long as it lives. A run this
monitor starts for the phone is not a child either: no provider process lies
between it and the monitor.

**Captured** (`capture.ts`). Claude Code and Codex give every command a chat
runs that chat's id (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`; Grok's
`GROK_SESSION_ID` is taken too), and a run inherits it. At each process sample
(`machine-load`) every headless provider root not started by this monitor is
looked at once: its environment is read for those variables alone, and its
working folder (or the `-C`/`--cd`/`--cwd` its command names) and start time are
kept. Only the variable of the provider directly above the run counts; one
inherited from a chat further up started that provider, not this run. A run
with no provider above it counts when exactly one chat is named. Nothing else
read from a process is logged or kept.

**Joined** (`attach.ts`, `links.ts`). The run's process does not say which
session it writes, so the run waits in `started-by.json` in the config
directory (`runs`, at most 256, a day at most) until the catalog shows a
headless session of the same provider in the same folder that started between
5 s before and 2 min after the process (or the one its `--session-id` named).
Each run joins one session, nearest start first. The link is then written keyed
by the child session (`links`, at most 4,000, six months) and outlives the run,
its process and the parent's transcript. The first link of a chat stands; a link
its own process named replaces one read from a transcript.

**After the fact** (`facts.ts`, `attach.ts`). A run whose process was never
seen (it ran before this runtime, or while the monitor was down) is matched
from the parent's transcript, conservatively. The scanners already read each
chat's transcript row by row; while they do, they keep the commands that start
another provider headless (Claude `Bash` calls, Codex `exec_command`, `shell`
and code-mode `exec` calls), in one spelling with shell quoting and escapes
dropped, with the time each ran: from the call to its result, or for a Claude
command sent to the background, until Claude's notification that it finished.
At most 32 such commands of 8 KB per chat are held, in memory only. A child is
linked to a chat when all of these hold, and to none when more than one chat
qualifies:

- the child is headless and started in the last 48 hours;
- its first request has at least 40 characters, and its first 64 (the whole
  request when shorter) appear in the command: a script that fills a template
  per picture keeps the template's opening;
- the command starts the child's provider headless;
- the child started between 3 s before the command and 10 s after it ended (a
  command never seen to end counts for six hours);
- the parent started before the child, is not the child, and was read on the
  same computer.

A command that runs a script naming no provider (`bash make-pictures.sh`) or
that builds each request from a file is not matched: the transcript does not
show the request. Such runs are linked only while their process is alive.

**Mesh** (`mesh/`). A child whose folder is no checkout of its own (a temp
folder, a plain folder without Git, one that is gone) is its parent's work: the
catalog places it in the parent's Mesh, as a Task of its own there, and binds
nothing for its folder. Parents are linked before their children within one
catalog; a parent linked by an earlier catalog is found by its Task. A child
whose parent this computer does not know registers no Mesh at all. A child in a
folder of its parent's checkout is in that checkout's Mesh as before, and a
child in a checkout of its own keeps that checkout's Mesh; both still publish
`startedBy`. A Mesh an older runtime registered for a child's folder (no
remote, no `.git` of its own, every chat of every Task in it started by another
chat) stays in the store and is left out of every list of this computer's
Projects, like a helper run's.

Tests live in `tests/`: command and session recognition, capture, transcript
matching (inside and outside a command's window, short requests, another
computer, two candidate parents), publishing and the stored links, and the
Mesh rules.

Licensed under the GrantTap Commercial Source License. See the repository root `LICENSE`.
