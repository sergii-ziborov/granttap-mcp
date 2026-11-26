# Account poller lease

Exactly one GrantTap process per computer answers phones signing in with the account. The monitor, the
local MCP service and every chat's stdio MCP server start `startAccountRecoveryPoller`, and on each
ten-second tick each asks `AccountPollLease.claim()`; only the holder polls
`/api/account/machine/requests`, which also keeps the account server's last-seen time for this
computer fresh (the phone wants it within two minutes).

`account-poller-lease.json` in the config directory (owner-only) names the holder: a random id, its
pid, its role (`monitor`, `service`, `chat`) and when it renewed. The decision runs under the file's
store lock, so two processes never both take it. The holder renews on every tick and before each phone
it answers. The next process that asks takes the lease over when the holder's process is gone, at once,
or when it has not renewed for 45 seconds (a hung process). A clean stop releases it. Taking it is logged
once per process: `[account] the background helper (pid …) answers phones signing in with the account`.
`activeAccountPoller()` reads who answers without taking anything, for `connection_status`.

Tests: `tests/lease.test.ts` (stale and dead holders, release, three real processes, two pollers where
only the holder asks the server).

This runtime module is covered by the repository GrantTap Commercial Source License.
