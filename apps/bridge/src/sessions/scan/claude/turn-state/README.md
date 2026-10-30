# Claude turn state

Root turn boundaries are shared by full discovery and bounded live observations.
An assistant end-turn record ends Working immediately; sidechain and progress
records do not reopen that root turn. A later user or queued turn reopens it.

Covered by sessions/tests/claude-turn-state.test.ts and session-catalog freshness tests.

This module uses the GrantTap Commercial Source License.
