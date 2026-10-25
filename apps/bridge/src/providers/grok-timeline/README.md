# Grok conversation timeline

Public entry: `grokTimeline` in `index.ts`. Grok's typed conversation rows omit
timestamps. Native `rewind_points.jsonl` binds each real prompt index to its
recorded start time; subsequent rows keep their native order within that turn.
Only the small clock prefix of each rewind row is retained, so file snapshots
are never parsed or copied into activity. Unchanged prompt clocks are cached.

A bounded tail of `events.jsonl` confirms the latest completed turn. A later
start, an unsuccessful outcome, or a completion older than the current prompt
cannot turn partial output into a final response. Existing activity identities
remain stable when native clocks replace the older session-start fallback.

Behavior tests: `../../sessions/scan/tests/grok-turn-time.test.ts`.
This module uses the repository's GrantTap Commercial Source License.
