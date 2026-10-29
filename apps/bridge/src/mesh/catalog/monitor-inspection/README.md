# Monitor repository inspection

Public entry: `prepareMonitorInspection` through the catalog entry point. The
monitor prepares Git observations asynchronously with the existing two-command
pool. Each catalog reads uncommitted work afresh. Only stable repository metadata
is reused for at most 30 seconds; missing repositories retry after five seconds.
An explicit refresh bypasses reuse. Retired directories are removed, older
in-flight results cannot replace a forced refresh, and cache size is bounded.

These are catalog observations. Explicit Git and Task transfer operations retain
their fresh native inspection and never use this observation cache as authority.
Tests cover fresh unsaved work, forced refresh, expiry, retirement and ordering.

License: GrantTap Commercial Source License in the repository LICENSE.
