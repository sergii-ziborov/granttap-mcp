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

**Short runs** (`live/`). A run a usage limit stops lives three or four
seconds, less than samples take to come round (every 2 s while chats work,
every 30 s while none does). On macOS the leading monitor also watches the
providers' session folders, in one stream per folder tree: a new transcript (a
Codex `rollout-*.jsonl`, a Claude chat's `<id>.jsonl` but no subagent's, a Grok
session's `chat_history.jsonl`) made in the last minute asks at once for one
listing of the provider processes, which captures runs as above and reports
nothing. A provider writes it about a second after its run starts. Listings are
single-flight: transcripts that appear during one ask for one more after it,
however many they are, so a batch of hundreds of runs costs at most one listing
per run and nothing while no transcript appears. Only file names and creation
times are read. A monitor that stops leading stops watching.

**Joined** (`attach.ts`, `links.ts`). The run's process does not say which
session it writes, so the run waits in `started-by.json` in the config
directory (`runs`, at most 256, a day at most) until the catalog shows a
headless session of the same provider in the same folder that started between
5 s before and 2 min after the process (or the one its `--session-id` named).
Each run joins one session, nearest start first. The link is then written keyed
by the child session (`links`, at most 4,000, six months) and outlives the run,
its process and the parent's transcript. The first link of a chat stands; a link
its own process named replaces one read from a transcript.

**After the fact** (`facts.ts`, `attach.ts`, `folders/`). A run whose process
was never seen (it ran before this runtime, while the monitor was down, or for
less time than one sample takes to come round) is matched from the parent's
transcript, conservatively: by its request, and failing that by its folder.
The scanners already read each chat's transcript row by row; while they do,
they keep the commands that start another provider headless (Claude `Bash`
calls, Codex `exec_command`, `shell` and code-mode `exec` calls), in one
spelling with shell quoting and escapes dropped, with the time each ran: from
the call to its result, or for a Claude command sent to the background, until
Claude's notification that it finished. At most 32 such commands of 8 KB per
chat are held, in memory only. A script's argument list starts the provider it
names (`subprocess.run(["codex", "exec", "-C", "/tmp/art", prompt])`); a
command line a chat only looks for (`pgrep`, `pkill`, `grep` or `ps` of
`"codex exec …"`) starts none. By its request, a child is linked to a chat when
all of these hold, and to none when more than one chat qualifies:

- the child is headless and started in the last 48 hours;
- its first request has at least 40 characters, and its first 64 (the whole
  request when shorter) appear in the command: a script that fills a template
  per picture keeps the template's opening;
- the command starts the child's provider headless;
- the child started between 3 s before the command and 10 s after it ended (a
  command never seen to end counts for six hours);
- the parent started before the child, is not the child, and was read on the
  same computer.

**By its folder** (`folders/`). A script that builds each request from a file
(`one.sh <index>` reading `prompts.json`, a Python loop over a queue, run
detached through `xargs`) leaves no request in the chat's commands, but they
still name the folder the runs work in. Each command that starts a provider
headless notes every folder it names: an absolute path (from `/`, `~` or
`$HOME`) as it is, or the folder of a file it names (`/tmp/art/one.sh`), never
the system's folders, a temp directory itself, the home folder or one above
it. Per chat, folder and provider, the time of the first such command is kept,
and the time of the chat's last command of any kind that named the folder or a
path inside it: at most 32 per chat, the folder named longest ago let go first,
in memory only, so a launch long out of the last 32 commands still counts. A
child its request did not link is linked when all of these hold:

- the child is headless, started in the last 48 hours, on this computer;
- its folder is one made for runs: gone, or holding no checkout and lying in
  none (asked once a minute per folder);
- exactly one chat read on this computer started the child's provider headless
  in a command naming that folder; when a second chat did, at any time, the
  folder links nothing;
- the child started between 3 s before that chat's first such command and
  12 hours after the chat last named the folder, so a batch left running
  detached, or waiting out a usage limit, stays its chat's;
- the parent started before the child and is not the child.

Such a link is written like any other read from a transcript (`source:
"transcript"`). A run in a checkout or in a folder two chats used, whose
request a script built from a file, or whose script names no provider and was
not written by the chat, is linked only while its process is alive.

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
Mesh rules. `folders/tests/` covers matching by folder on a course's real shapes
(`lessonart.ts`: a script written then run detached, a Python batch, a Grok
worker): two chats naming one folder, a checkout or a folder inside one, runs
outside the window, and the catalog that results. `live/tests/` covers the
watch, and on macOS a real run that lives 1.6 s, caught while it lives and
joined to its session.

Licensed under the GrantTap Commercial Source License. See the repository root `LICENSE`.
