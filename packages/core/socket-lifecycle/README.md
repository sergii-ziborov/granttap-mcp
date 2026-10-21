# Relay socket lifecycle

Public entry point: `index.ts`. `RelayClient` uses this module for network health
and short managed admission leases. Admission refresh stays on the existing
socket and does not rotate task keys or reload transcript state. A failed lookup
cannot extend the server's signed expiry. Closing or replacing a socket cancels
only its own timers.

Reconnect pacing resets only after a non-policy connection lived at least 30
seconds. Short handshakes keep exponential backoff and jitter. WebSocket
`retry-after` reasons and HTTP `Retry-After` are lower bounds even when they
exceed the ordinary retry cap. Foreground polling cannot bypass a scheduled
retry. None of these waits delay a submission already persisted on the relay.
Every endpoint advertises its public-key digest before the upgrade, including
transient machine hooks, so a server can refuse a cooled identity before it
receives any ciphertext. This digest grants no permissions or decryption rights.

The real WebSocket integration is in `tests/core/managed-relay-renewal.test.ts`.
`RelayClient.onConnected` observes each actual socket opening, including recovery.
Consumers can immediately replace stale snapshots; notification failures cannot
interrupt the transport, and unsubscribing prevents later callbacks.

Licensed under the GrantTap Commercial Source License in the repository root.
