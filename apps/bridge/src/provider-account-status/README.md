# Provider account status

Public entry: `index.ts`. The catalog loop reads the installed, already signed-in
Codex app-server's `model/list` and `account/rateLimits/read`. No conversation or
turn is created, no authentication flow is started, and chat delivery never waits
for the account request. Reads coalesce and are throttled to two minutes; reports
expire after five minutes and changing the native auth file clears the cache.

Only visible picker metadata and reported usage percentages, window durations,
reset times and observation times cross the existing encrypted Mesh channel.
Identity, credentials, credits, instructions and raw provider responses stay out.
Missing windows remain unknown. `native-usage/reader.ts` independently reads the
already signed-in Claude, Cursor and Grok account interfaces, with an eight-second
request bound, a 64 KiB response bound and no redirects. Requests coalesce and
refresh at most once every two minutes. Expired windows disappear without
inventing a reset allowance. `native-usage/credentials.ts` reads existing native files
or the native macOS keychain entries; it never starts login, refreshes credentials
or changes provider settings. A relocated profile cannot use another account's
keychain. Temporary HOME directories never read the OS user's keychain.

Claude CLI aliases remain available. The GrantTap status-line wrapper observes
Claude's documented `rate_limits` after a native response, preserves the prior
status command/options, and stores only independently present 5h/7d windows.
Its newest real observation takes precedence over an older direct read. Expired
Claude credentials require a native Claude refresh; they are not a full allowance.

Cursor reports its weekly account usage, with the native billing-period pool as
a fallback for older plans. Grok reports its current subscription period and
credit usage percentage through its CLI billing interface. Unified subscriptions
may share a pool across Cursor and Grok: these are provider views, not additive
allowances. Grok's reported percentage can be rounded by the provider. A missing
or unauthenticated account report stays unknown. Session tokens, context size and
tool activity do not stand in for subscription limits.

Tests live in `tests/`. GrantTap Commercial Source License, see root LICENSE.
