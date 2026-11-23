# Context compaction

Public entry: `index.ts`. GrantTap compacts a Claude Code or Codex chat's context with the provider's
own command, never by asking the model to summarise in a normal prompt.

## Claude Code

Claude Code compacts a resumed chat headless: `claude -p --resume <chat> --output-format stream-json
--verbose /compact`, run in the chat's folder under the chat's delivery key (`claude.ts`). It prints
`compact_boundary` with `pre_tokens` and `post_tokens`; the transcript gets the same boundary, Claude's
summary and `/compact`'s own lines, and the chat goes on from the summary under the same id. A refusal
(a failed compaction status, the command's own output, an error result) comes back in Claude's words.
Checked against Claude Code 2.1.330 on a throwaway chat; `tests/fake-claude.ts` replays those rows.

Codex keeps its app-server compaction (`../providers/codex-control.ts`).

## When

Only between turns (`compactChat`). A chat is refused while its turn runs, while a GrantTap run or a
queued phone message waits for it, while it is already being compacted, and for Claude while a running
Claude Code lists the chat in `~/.claude/sessions/<pid>.json` (the same process, by its start time): a
chat open there keeps its conversation in memory, and a compaction written beside it would not reach it.

The phone's Compact now (`session.compact`) is taken at once and answered with `session.compact.result`
when the compaction ends, which for a context near a million tokens takes minutes.

## Threshold

Each catalog the leader publishes is looked at for a chat that reached its threshold since its last
turn (`trigger.ts`): idle for 20 s, not paused, waiting on no background work or account limit, with a
reading of its own from the last two hours, newer than its last compaction and not tried before. One
chat at a time across the computer; a reading is tried once, so a refusal waits for the next turn.

The default is 400k tokens for Claude and off for Codex (`DEFAULT_AUTO_COMPACT_TOKENS`). Claude Code's
own default for its million-token models compacts at about 967k: the window less 20k for the summary
and a 13k buffer. Every request of a turn sends the whole context again, so 400k spends less than half
as much of the subscription per request as a chat near that end, and still leaves a long turn more
than half the window before Claude's compaction would run in the middle of it. Codex compacts itself
near the end of a far smaller window. The phone sets a chat's threshold, turns it off or back to the
default with `session.autocompact.set`.

## What the phone sees

`SessionInfo.compaction`: how many compactions the transcript records, the newest with the context
before and after where the provider said, who made it (`auto` and `manual` are Claude's own; `provider`
is a Codex one; `phone` and `threshold` are this computer's runs, matched to the transcript by time),
the threshold in force and whether it is the default, and `running` while this computer compacts it.
The chat shows a compaction as one status line instead of Claude's summary.

State: `context-compaction.json` in the GrantTap folder (`store.ts`): the thresholds set per chat, the
last eight runs per chat and the reading each automatic compaction was tried for. The monitor log has
one line when a threshold is reached and one with the outcome, naming the chat by the start of its id.

Tests: `tests/`.

License: GrantTap Commercial Source License; see the repository LICENSE.
