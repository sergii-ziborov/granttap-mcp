# Desktop code file sections

`desktop.code_file { project_id, repository_id, path, request_id? }` gives the Mac app every section
of one file of a repository's code map, as `{ operation: "desktop.code_file", result }` where
`result` is exactly the phone's `project.code_file.result` (camelCase; `requestId` is `request_id`,
or `"local"`). Input is validated with the phone's own query schema; an invalid one closes the
socket like every other desktop operation.

It never waits for an analysis. A repository the Engine has not analysed since it started answers
`analyzing` and the analysis starts in the background, joined by later polls; the app asks again
until the answer is `ok` or names why there are no sections. Reads use the bridge's Engine channel;
an analysis opens its own. The behaviour is `apps/bridge/src/code-file-sections`.

Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
