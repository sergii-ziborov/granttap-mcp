# Task control

`controlTaskSession` and `compactTaskSession` are the shared machine implementation
for encrypted phone commands and authenticated native desktop commands. Pause is
saved before deliveries are interrupted. Resume optionally starts a continuation
after sending its acknowledgement. Codex compaction requires an idle native session.

Transport handlers own admission and result routing. The durable hook hold is
enforced by configuration capability policy, independently of client presentation.
Regression scenarios: `tests/session/session-pause.test.ts` and the desktop
Task-control module tests.

Covered by the [GrantTap Commercial Source License](../../../../LICENSE).
