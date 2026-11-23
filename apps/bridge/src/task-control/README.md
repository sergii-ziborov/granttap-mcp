# Task control

`controlTaskSession` and `compactTaskSession` are the shared machine implementation
for encrypted phone commands and authenticated native desktop commands. Pause is
saved before deliveries are interrupted. Resume optionally starts a continuation
after sending its acknowledgement. Compaction runs the provider's own command, Claude Code's
`/compact` or Codex's app-server compaction, only between turns; see
[`../context-compaction`](../context-compaction/README.md).

Transport handlers own admission and result routing. The durable hook hold is
enforced by configuration capability policy, independently of client presentation.
Regression scenarios: `tests/session/session-pause.test.ts` and the desktop
Task-control module tests.

Covered by the [GrantTap Commercial Source License](../../../../LICENSE).
