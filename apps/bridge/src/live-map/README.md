# Live map

Public entry: `index.ts`. While a phone has a chat's live map open, this computer
sends it a compact stream of what the chat's agent does, by name only, and the
phone draws it: the agent in the centre, ten stations around it, a pulse along a
spoke for each call. The idea and the station rules come from
[lot-map](https://github.com/alexeyw/lot-map) (MIT, Aleksei Volodin), a Claude
Code mod that draws the same map beside the chat on the same computer. GrantTap
does not ship or run the mod; it reads the records it already reads for every
provider and the phone draws the map. See `THIRD_PARTY_NOTICES.md`.

## Contract

The phone sends `session.pulses.subscribe { sessionId, active }` in its device
box when the map opens and renews it every few seconds; `active: false` or
twenty seconds without a renewal ends it. At most four maps are fed at once, a
fifth taking the place of the oldest. Only the routing monitor answers.

Each open map gets at most one `session.pulses` frame a second, and one every
five seconds when nothing happens, so the phone can tell the map is live. A
frame holds at most 48 pulses and 12 KB; what does not fit is counted in
`dropped`, the newest kept. `running` names every call still at work, so a
phone that missed a frame ends what no longer runs; `counts` are each station's
calls in the chat's window, for the worn spokes. The first frame of a
subscription is a `replay` of the chat's last 24 pulses.

A pulse is a station, a name, `start`/`end`/`done`, `run`/`ok`/`error`/`blocked`,
its time and duration, a subagent's digest, how many run at that station at
once, and a `mark` for moments that are not calls: the person's message, the
answer, a model step or change, a compaction, the hook asking for approval.
The frame adds the model's name and, where the provider reports the window
(Codex), the share of the context window; for Claude only its tokens.

Frames travel under the chat's own key to the phone that asked, `reliable:
false` with a ten-second lifetime: never into the relay's mailbox, and in the
replaceable lane, so they cannot go ahead of an answer and are the first to
give way when the upload backs up. The chat's key is granted once per
subscription.

## What leaves and what does not

The readers (`readers/`) take a chat's recent records: the last 768 KB of a
Claude or Codex file and 256 KB of each of up to three Claude subagent files
written in the last fifteen minutes, read again only when the file's size or
time changed; Cursor and Grok Build from the rows GrantTap already reads. The
classifiers (`classification/`) read a call's input to choose its station:
a shell line for the command it runs (`curl` is Network, `rg` is Files), a path
for Claude's or Codex's memory folder. A result is read only for an exit code or
for words that say a hook or the person refused it.

What leaves is a tool's name (`Bash`, `exec command`, `github: create issue`), a
skill's or agent type's name when it is a plain identifier, and a model's id.
Never an argument, path, host, command line, description, prompt, result or
message text. Provider call and subagent ids are replaced by digests.

## Stations

`you` (messages, questions, plans and to-dos, GrantTap's own ask and notify),
`model` (each step, a compaction, a change of model), `memory`, `files`,
`shell`, `web` (Network: fetch, search, MCP servers, network commands),
`browser`, `agents`, `skills`, `hooks` (an approval GrantTap's hook asked for).
lot-map's Claude Code names are kept, and Codex (`exec_command`, `apply_patch`,
`update_plan`, `spawn_agent`, `web_search_call`), Cursor (`Shell`, `StrReplace`,
`CallMcpTool`) and Grok Build (`bash`, `read_file`) names are added.

Tests live in `tests/`, including a round trip between a real computer and
phone `RelayClient` through a relay that sees only ciphertext.

GrantTap Commercial Source License, except the ported lot-map portions, which
remain MIT; see the repository LICENSE and THIRD_PARTY_NOTICES.md.
