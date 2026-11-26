# Code map

`code-map.ts` is a repository's bounded code map in the Mesh snapshot (`ProjectRepositoryGraph.codeMap`):
files, their sections (`CodeSymbol`), external resources and the links between them. Byte budgets cut
sections first, so a file there may list only some of its sections. Older computers and phones validate
it strictly; it gains no fields for the per-file read below.

`code-file.ts` is that per-file read. `project.code_file.query` (phone to computer, strict:
`type`, `projectId`, `repositoryId` 1–512, `path` repository-relative 1–512, `requestId` 1–128,
`createdAt` finite) asks for every section of one file. `project.code_file.result` (computer to
phone, strict) answers with the same scope, `status` (`ok`, `analyzing`, `not_found`, `not_bound`,
`engine_unavailable`, `analysis_failed`), optional `revision` (1–512), `analysisId` (1–128),
`language` (1–64) and `lineCount` (positive), `symbols` (at most 2,000 `CodeSymbol`s), `totalSymbols`
(at least the listed count), `truncated` and `createdAt`. Only `ok` carries sections. A result is at
most 160 KiB serialized; the computer drops trailing sections to fit and sets `truncated`.
`analyzing` means keep waiting: the computer is filling its Engine's code map and answers again.
Computers up to 0.8.212 never answer the query. See `apps/bridge/src/code-file-sections/README.md`.

Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
