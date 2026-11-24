# Claude turn state

Root turn boundaries are shared by full discovery and bounded live observations.
An assistant end-turn record ends Working immediately; sidechain and progress
records do not reopen that root turn. A later user or queued turn reopens it.

A queued row Claude removes again without a turn (`remove`, such as a background command's
notification a subagent took, `absorbed_mid_turn`) leaves the chat as it was before it was queued.
Until 0.8.204 such a pair after a finished turn made the turn look unfinished, which hid the background
agents it still waited on: the chat looked free to compact or automate while they worked.

The background work a finished turn waits on (`waits.ts`) is shown as `backgroundTasks`. When Claude
Code stops it at its print-mode ceiling, the chat is continued by `../../../../background-continuation`.

Covered by sessions/tests/claude-turn-state.test.ts and session-catalog freshness tests.

This module uses the GrantTap Commercial Source License.
