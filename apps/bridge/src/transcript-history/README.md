# Transcript history

Public entry: `index.ts`. Native Codex root conversations are read in bounded
backward pages with file-bound cursors. Pages retain their ids while the native
log grows and include the user question before the first answer when available.
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
