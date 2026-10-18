# Provider account status

Public entry: `index.ts`. The catalog loop reads the installed, already signed-in
Codex app-server's `model/list` and `account/rateLimits/read`. No conversation or
turn is created, no authentication flow is started, and chat delivery never waits
for the account request. Reads coalesce and are throttled to two minutes; reports
expire after five minutes and changing the native auth file clears the cache.

Only visible picker metadata and reported usage percentages, window durations,
reset times and observation times cross the existing encrypted Mesh channel.
Identity, credentials, credits, instructions and raw provider responses stay out.
Missing windows remain unknown. Claude CLI aliases remain available. The GrantTap status-line wrapper observes
Claude's documented `rate_limits` after a native response, preserves the prior
status command/options, and stores only independently present 5h/7d windows.
Cursor and Grok subscription limits remain unavailable when their installed
interfaces do not report them; their session tokens and tools are still counted.

Tests: `tests/status.test.ts`. GrantTap Commercial Source License, see root LICENSE.
