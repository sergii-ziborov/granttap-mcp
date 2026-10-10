# Transcript history

Public entry: `index.ts`. Native Codex root conversations are read in bounded
backward pages with file-bound cursors. Pages retain their ids while the native
log grows and include the user question before the first answer when available.
Ordinary reads use 1 MiB windows; reads expand up to 16 MiB when needed to fit
a complete native row. Cursor creation uses file identity and offsets without
rereading the body. Apple clients automatically retain all pages of active chats.
Provider reasoning is not exposed. Unsupported providers retain their existing
transcript reader.

`changes.ts` projects completed native FileChange items into per-file counts and
redacted diffs. These are recorded edits, not a claim about the final Git working
tree. Older logs fall back to explicitly successful patch calls. JavaScript
wrapper calls are inspected as literals, never executed. `turn-changes.ts` reads
back to the native turn boundary so the completed reply includes edits outside
the visible page. Reads, file lists and diff previews are bounded; partial
summaries and truncated diffs carry explicit flags. `tool-details.ts` keeps
readable bounded call/result text independently of the compact timeline label.

Behavior tests live in `tests/`. Licensed under the [MIT License](../../../../LICENSE).

## Claude history

Claude uses the same backward native JSONL cursor and bounded visible pages as
Codex. Source UUIDs (or a row digest for older logs) identify user/assistant
messages independently of their position in a moving window. The shared Apple
client walks pages until it has the current and previous user requests, and
fetches the next older boundary immediately when navigating backward.
`tests/claude-history.test.ts` covers a long turn, repeated requests, stable
page retries and live snapshot identities.
