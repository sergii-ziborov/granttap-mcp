# Code file sections

The phone's code map gets each repository's files in the encrypted Mesh snapshot, which every
repository of the Mesh shares within 192 KiB (`../engine/runtime/engine-projects.ts`). Its byte budget
cuts sections first, so a file there often shows one of its many functions. When a person opens a
file, the phone asks the computer for that one file's sections, and the snapshot keeps its bounded
overview.

`project.code_file.query { projectId, repositoryId, path, requestId, createdAt }` comes from the
phone; `relay.ts` answers it with `project.code_file.result` (schema in
`packages/protocol/messages/mesh/graph/code-file.ts`), sealed under the Project's key for the asking
phone alone, five minutes on the relay.

- The first answer goes out before the handler returns. A repository this computer holds no binding
  of in that Mesh, or a Mesh turned off, is `not_bound` without reaching the Engine.
- `index.ts` reads the file from the Engine (`graph.code_file`, Engine 0.1.10), a read of the memory
  its last `graph.analyze_repository` filled. `ok` carries every section in the Engine's order, in
  the code map's own section objects. `CODE_FILE_NOT_FOUND` is `not_found`; an unbound repository is
  `not_bound`; an Engine that is off, unreachable or too old to know the operation is
  `engine_unavailable`.
- When the Engine has not analysed the repository since it started (`CODE_MAP_NOT_CACHED`), the
  phone hears `analyzing` at once, meaning keep waiting. `analysis.ts` then admits this computer's
  checkouts again, picks the checkout graph publication analyses for that repository
  (`graphAnalysisBindings`) and joins or starts that repository revision's job in the one analysis
  queue (`../engine/runtime/repository-graph/analysis.ts`), with the explicit build's ten minutes.
  The file is read again and the final answer follows: `ok`, `analysis_failed`, `not_bound` or
  `engine_unavailable`. That analysis also refreshes the report Mesh publication sends.
- The same file asked while it is being answered shares the answer; a phone that joins during an
  analysis hears `analyzing` at once. One Engine read per repository runs at a time; other
  repositories do not wait. At most 32 files are answered at once and eight requests join one file;
  a query beyond that throws, so the monitor's log names it (`../monitor/dropped-requests`). A
  finished analysis stands for 30 seconds, so a poll does not start the same failing scan again.
- A query the relay held for more than ten minutes is taken without an answer.
- `wire.ts` keeps an answer within 2,000 sections and 160 KiB: trailing sections make way,
  `truncated` says so and `totalSymbols` still counts the file's sections. A section the wire cannot
  carry is left out the same way.

The Mac app asks through `desktop.code_file` (`apps/mcp/src/desktop/code-file`), which uses `poll`:
it never waits for an analysis, starts it on a miss and says `analyzing` until a later poll finds
the file.

Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
