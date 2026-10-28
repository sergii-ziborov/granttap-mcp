# Persisted Grok conversation

[`readGrokConversation`](index.ts) reads native `updates.jsonl`, the ACP restore
transcript. Model `chat_history.jsonl` may be compacted and is only a fallback
when the persisted transcript is absent. Thinking, hook output, raw tool output
and model-only summaries never become visible messages.

Visible text chunks keep a stable native record identity while streaming.
Successful `turn_completed` marks only the current answer as final. Tool calls
use native IDs, and file changes require completion of that exact call. Native
diffs are bounded replacement hunks; sensitive files remain excluded.

The incremental reader retains at most eight session projections, reads at most
64 MiB per pass, accepts at most 8 MiB per JSON record and retains at most 4,096
visible entries and 8 MiB of projected data. Individual visible messages are
bounded to 64 KiB, and at most 256 pending tool completions are retained. Full transfer capture refuses incomplete or bounded input
instead of calling a partial archive complete. Older CLIs without `updates.jsonl`
retain their previous reader. Tests live in
`../../sessions/scan/tests/grok-persisted-updates.test.ts`.

Licensed under the repository-root GrantTap Commercial Source License.
