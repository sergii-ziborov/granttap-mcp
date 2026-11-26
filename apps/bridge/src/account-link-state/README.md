# Account link state

One answer to "is this computer signed in to its GrantTap account, and may it use GrantTap's relay?",
the same in every GrantTap process: the background monitor, the local MCP service, each chat's stdio
MCP server, the connection card and `granttap status`.

| `state` | Meaning | Written by |
| --- | --- | --- |
| `none` | No `account-link.json`: never signed in | (read from the missing file) |
| `ok` | The account service accepted the sign-in; `checkedAt: null` until one answer came | poll 200, admission 200, `verifyAccountLink` |
| `revoked` | GrantTap no longer accepts it (removed in Devices, signed out): sign in again | poll 401, admission 401 or 403 "revoked" |
| `seat_limit` | Signed in, but the plan's computer places are all in use | admission 403 `code: seat_limit` |
| `no_subscription` | Signed in, but no subscription covers this computer | admission 403 `code: subscription_required`, or today's combined 403 sentence |
| `unreachable` | No answer for three checks in a row (about 30 s) | network errors, 5xx, 404, 400 |

`index.ts` keeps `{state, reason, checkedAt}` in `account-link-status.json` in the config directory
(owner-only, `0600`) next to a 16-hex fingerprint of the saved sign-in, never the token: a new sign-in
starts a fresh state. The read-compare-write runs under the file's store lock, so each change is written
and logged once whichever process saw it (`[account] this computer's GrantTap sign-in is revoked (was
ok): …`); a sign-in that works is not logged, a recovery is (`ok again (was …)`). A state that does
not change is written again at most once a minute.

Rules (`nextAccountLinkState`): a poll proves the sign-in, not the subscription, so only an admission
clears `seat_limit` or `no_subscription`; an unanswered check never replaces `revoked` or a coverage
refusal, and calls a working sign-in `unreachable` only after three in a row in one process.

`server-answers.ts` reads only the status, the server's short `error` sentence and an optional `code`.
The 0.8.214-era account service answers 403 "No active managed access or the computer limit has been
reached." for both a full plan and no plan; that reads as `no_subscription` with the server's sentence
as the reason until the service sends `code`. `origin.ts` is the account-service origin every process
uses (`GRANTTAP_WEBSITE_ORIGIN`, none in tests). `verifyAccountLink` asks
`GET /api/account/machine/identity` once, as `granttap sign-in` does when a sign-in finishes; a token
never goes over plain http.

Tests: `tests/state.test.ts` (answers, transitions, the file, one log line per change).

This runtime module is covered by the repository GrantTap Commercial Source License.
