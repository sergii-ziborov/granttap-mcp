# Which chat started this MCP server

Public entry: `index.ts` (`chatBinding`). `sessionFromEnvironment` and
`sessionBindingFromEnvironment` in `../mcp-tools/mesh/session-env.ts` delegate here, so every reader of
the calling chat uses it: the scoped `granttap://mesh/current` and `granttap://mesh/map` resources,
attribution of `notify`, `ask`, `ask_yes_no` and `offload_task`, and the chat part of
`connection_status` (the phone messages queued for the chat and its limit continuation).

Each host names its chat differently. What each one gives an MCP server it starts was read from real
processes on a Mac (environment variable names only) and from the hosts' own documentation:

| Host | What names the chat | Source |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_SESSION_ID` in the server's environment | environment |
| Grok Build | `GROK_SESSION_ID`, which Grok sets when it spawns an MCP server (the same id as the session folder) | environment |
| Codex CLI | Codex starts MCP servers with a bare environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `USER`, `__CF_USER_TEXT_ENCODING`); the Codex process holds its chat's `sessions/…/rollout-<time>-<thread id>.jsonl` open, and exactly one open rollout names the chat | transcript |
| Cursor | One MCP server serves all of a window's chats, so no server-wide id exists; `beforeMCPExecution` records each GrantTap call with its `conversation_id` | hook, per call |

`processes.ts` finds the nearest coding agent above this server: it walks at most six ancestors (the
launchers between a host and the server: `granttap mcp`, `npm exec`, `node -e`, a shell, Claude's
`disclaimer` wrapper) with `ps` on macOS and `/proc` on Linux, and recognises a host by its own
executable (`claude`, `codex`, `grok…`, `cursor-agent`, the Cursor app) or, for an npm install of
Claude Code, its script. Only that host's source is read. A Grok or Cursor run that a Claude Code chat
started from its shell inherits `CLAUDE_CODE_SESSION_ID`; its server belongs to the run, not to that
chat, so the inherited id is ignored. Command lines are only matched against those patterns and are
never logged or kept.

A Codex process that holds several rollouts open (the desktop app's shared server, a chat with live
subagents) names no chat; its open files are read again after ten seconds, so a server that was
started before its chat's rollout opened, or outlives a subagent, is not stuck with an old answer.
`CODEX_THREAD_ID`, which Codex gives the commands a chat runs, is taken if Codex ever sets it for its
MCP servers.

Where the process tree cannot be read (Windows, a process another account owns, a host this module
does not know), exactly one of the three provider variables names the chat and two name none. No chat
is ever guessed from a working directory, and nothing the model passes names one.

`../status/chat-status.ts` (`callingChat`) adds the per-call identity: the provider hooks of Claude
Code, Codex and Cursor record each GrantTap tool call they see with the chat that made it
(`../../../bridge/src/mesh/identity/call-scope.ts`, now including `connection_status`). A server that
knows its own chat takes only that chat's record; one that knows none takes a record only when a
single chat made that exact call. `connection_status` reports `chat.identifiedBy` as `environment`,
`transcript` or `hook`.

Test processes are not started by a coding agent: under `node --test` the real process tree is not
read, and tests supply a probe with `setChatProcessProbe`. Tests: `tests/chat-identity.test.ts`,
`../connection-center/tests/status-details.test.ts`.

Not verified on a live host here: Grok's variable was read from its binary's MCP spawn code and hook
documentation (a Grok turn needs a signed-in account), and Cursor's own CLI (`cursor-agent`) was not
installed; its chats are named by the hook like the Cursor app's.

License: [GrantTap Commercial Source License](../../../../LICENSE).
