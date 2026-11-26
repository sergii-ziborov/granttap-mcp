# Token usage per hour

Part of GrantTap MCP, licensed under the [GrantTap Commercial Source License](../../../../../LICENSE).

Public entry point: [`index.ts`](index.ts). The phone's Usage screen says when tokens were spent and
where they went. A chat's lifetime `tokensSession` cannot say what a period spent, so each provider
reader also counts the same tokens per clock hour while it reads a transcript, and the capability
usage status (`scanCapabilityUsage`) publishes period figures built from those counts as `tokenUsage`
(contract: `packages/protocol/messages/README.md`).

## What is counted

"Tokens" are exactly what the reader already adds into `tokensSession` for that turn, so a chat whose
whole life lies inside a period spends in it what its `tokensSession` says, subagents included:

- Claude: each row's `message.usage` as `sumClaudeUsage` adds it (input, output and cache writes, never
  cache reads), at the row's `timestamp`, with the row's `message.model` (`<synthetic>` is none).
  Subagent logs (`transcript-reading/summary.ts`, read by `child-reading/`) are counted the same way and
  belong to the chat, once per subagent as `aggregateChildThreads` adds them.
- Codex: what each `token_count` adds to the rollout's running `total_token_usage` (cached input left
  out), at that row's time, with the model of the turn context before it. The reader sees a rollout's
  first 128 KB and last 512 KB: in a larger one, what the unread middle spent is counted at the first
  `token_count` after it. A running total that went down is not counted as negative spend.
- Cursor: each row's usage, or the estimate from its text, as the summary adds it, with the row's model.
  Cursor rows usually carry no time; those turns count at the chat's `lastActivityAt`.
- Grok: the estimates the reader makes from visible text and tool input, at the row's time or its
  prompt's native clock; without either, at the chat's `lastActivityAt`. Grok names no model per turn.

A turn without a model of its own counts toward the chat's model (`SessionInfo.model`); with neither,
it counts toward the totals and the chat, never the models list. A Grok helper run, which is no chat
of its own and whose spend is not its parent's, is not counted.

## Where the counts live

The hours never join `SessionInfo`: the sessions list goes to the phone and must not grow. A reader
keeps a `TokenHours` count in its cached state (Claude's `ClaudeParseProgress`, so an incremental read
of an appended transcript adds only the new rows) and a pruned snapshot (`TokenHour[]`, at most 31
days) in its summary cache beside the capability observations: `claudeTokenHours`,
`codexTokenHoursBySession`, `cursorTokenHours`, `grokTokenHours`. Publishing reads only those caches,
never a transcript. History chats are read by the same scans as live ones, so they have their hours too.

## Periods

`tokenUsageOf(perSession, now)` builds the 24-hour, 7-day and 30-day figures. Hours are the computer's
local clock hours. A period counts the hours that start at or after the hour holding `now` minus the
period, so it reaches up to an hour further back than the exact period. `tokens` is every chat's spend
in it; `chats` (heaviest 12) and `models` (heaviest 16, per agent) list only the heaviest, and a chat
with nothing in the period is not listed. `hours` are the last day's hours with spend, at most 25,
oldest first. A turn timed after `now` counts in the current hour.

Only the chats the status is built over are counted: the live catalog and the bounded history
(the 200 newest transcripts per provider, at most 200 history chats).

Tests live in `tests/`: the periods, the status, and the Claude (incremental reads, subagents) and
Codex (running totals, forked agents) readers. Grok's is `../scan/tests/grok-token-hours.test.ts`,
Cursor's the repository's `tests/cursor/cursor-token-hours.test.ts`.
