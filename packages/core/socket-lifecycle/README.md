# Relay socket lifecycle

Public entry point: `index.ts`. `RelayClient` uses this module for network health
and short managed admission leases. Admission refresh stays on the existing
socket and does not rotate task keys or reload transcript state. A failed lookup
cannot extend the server's signed expiry. Closing or replacing a socket cancels
only its own timers.

The real WebSocket integration is in `tests/core/managed-relay-renewal.test.ts`.

Licensed under the GrantTap Commercial Source License in the repository root.
