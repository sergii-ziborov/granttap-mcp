# Engine code file read

`index.ts` declares Engine 0.1.10's `graph.code_file { project_id, repository_id, path }` and parses
its answer: one file's `revision`, `analysis_id`, `language`, `line_count`, every section
(`id`, `label`, `kind`, `start_line`, `line_count`, optional measured `metrics`), `total_symbols`
and `truncated`. The answer's operation is `graph.code_file`; the file is read under `file`, under
`code_file` or beside `operation`. Malformed values fail the response; absent measurements stay
absent. Refusals keep their Engine code (`CODE_MAP_NOT_CACHED`, `CODE_FILE_NOT_FOUND`,
`REPOSITORY_NOT_BOUND`, `INVALID_OPERATION`); an Engine before 0.1.10 refuses the unknown operation
as `INVALID_REQUEST`.

The runtime read is `../../runtime/repository-graph/code-file.ts`. Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
