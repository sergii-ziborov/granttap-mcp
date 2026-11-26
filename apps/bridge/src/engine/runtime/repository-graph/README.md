# Repository graph delivery

[Runtime entry point](../engine-projects.ts) · [Wire fitting](fit.ts)

The encrypted Mesh snapshot carries bounded, observed repository metadata.
`fitRepositoryGraph` preserves file identities, measured LOC and source sections.
When directed file links dominate the wire budget, it reduces those links before
discarding source sections. The bounded sample keeps links reaching previously
unrepresented files and external services, then fills in original report order.
It never invents links, reverses their direction, or edits the engine report.

Remaining reductions retain the existing wire limit and mark partial evidence.
The persistent cache keeps a last successful bounded report through an MCP
restart while the normal observation refresh obtains current engine evidence.

Behavior tests live in `tests/`; runtime and cache integration scenarios remain
under the repository's `tests/engine` harness.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.

Every `graph.analyze_repository` this process starts goes through one queue in `analysis.ts`:
background publication, a person's Graph build and a code file's sections join the same repository
revision's job, so a repository is not scanned twice at once. That analysis is also what fills the
Engine's in-memory inventory of every file's sections. Publication may serve a persisted report
without calling the Engine; the Engine's memory then stays empty until the next analysis.

`code-file.ts` reads one file from that memory (`graph.code_file`, Engine 0.1.10) for
`project.code_file.query` and `desktop.code_file`, on its own short-lived socket with a ten-second
limit. It never scans: `CODE_MAP_NOT_CACHED` comes back as `not_cached`, and the caller starts the
analysis (`../../../code-file-sections`). Refusals become the phone's reasons: `not_found`,
`not_bound`, `analysis_failed`, or `engine_unavailable` for an Engine that is off, unreachable or
before 0.1.10. A path over 512 bytes, or an answer naming another file, is never a file's sections.

Successful background reports retain an internal observation of Git-visible
source state. Unchanged state reuses the report across time and MCP restart;
changed state retains the existing analysis cooldown. Explicit refresh forces
analysis, and temporary failures keep their retry behavior. Source observation
is implemented by `source-state/`; its tests cover dirty edits and path changes.
