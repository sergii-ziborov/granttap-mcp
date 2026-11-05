# Encrypted outbound scheduling

Public entry point: `index.ts`. Preserves per-peer encrypted envelopes while
pacing a connection below the managed relay's 300-frame-per-second admission
limit. Explicit approval and configuration messages take priority over queued
replaceable snapshots. TCP write completion, bounded queued bytes, cancellation
on disconnect, and a fresh queue on reconnect prevent stale bursts from crossing
connection generations. No message content or keys are logged.

Disconnect rejects the current write as well as queued frames. Catalog and
history publishers can retry on the next connection even if the previous
socket never calls its write-completion callback.

Tests live in `tests/`; they include an actual WebSocket server with the relay's
rate limit. A socket write is transport evidence, never an approval receipt.

GrantTap Commercial Source License; see the repository LICENSE.
# Controller delivery

Catalogs, liveness and shared conversation updates reach every authorized
controller, including a phone receiving passively. Silence never removes access
to its local replica. Authenticated history, subscription and image requests
return their independent key grant and encrypted result only to the requesting
controller, with priority over queued periodic snapshots. Older callers without
a requester retain the complete authorized recipient set. Every explicit target
passes the pairing and controller authorization checks. Routing never deletes a
pairing or changes approval policy.
