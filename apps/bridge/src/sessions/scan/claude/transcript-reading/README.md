# Cooperative native transcript reading

`readTranscriptRows` preserves complete UTF-8 JSONL rows, partial final appends,
and exact byte/tail checkpoints. It yields between bounded read/parse batches
and while assembling a long row. Long rows are assembled once rather than
recopied after every chunk. `createChildSummary` retains only native identity,
timestamps and reported token metadata; it preserves the array reader's result.
Its `tokenHours()` is the same spend per clock hour and model, kept for the
chat's token usage and never part of the published child
([token usage](../../../token-usage/README.md)).

Behavior is exercised by the Claude reader's `tests/transport-continuity.test.ts`
and `tests/incremental-parse.test.ts`, including real file reads, growing children,
replacement/rewrites, missing newlines and callbacks during a long row.

License: [GrantTap Commercial Source License](../../../../../../../LICENSE).
