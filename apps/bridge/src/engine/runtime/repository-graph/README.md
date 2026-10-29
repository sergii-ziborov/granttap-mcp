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

Successful background reports retain an internal observation of Git-visible
source state. Unchanged state reuses the report across time and MCP restart;
changed state retains the existing analysis cooldown. Explicit refresh forces
analysis, and temporary failures keep their retry behavior. Source observation
is implemented by `source-state/`; its tests cover dirty edits and path changes.
