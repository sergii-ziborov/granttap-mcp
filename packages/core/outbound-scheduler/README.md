# Encrypted outbound scheduling

Public entry point: `index.ts`. Preserves per-peer encrypted envelopes while
pacing a connection below the managed relay's 300-frame-per-second admission
limit. Explicit approval and configuration messages take priority over queued
replaceable snapshots. TCP write completion, bounded queued bytes, cancellation
on disconnect, and a fresh queue on reconnect prevent stale bursts from crossing
connection generations. No message content or keys are logged.

Tests live in `tests/`; they include an actual WebSocket server with the relay's
rate limit. A socket write is transport evidence, never an approval receipt.

MIT License; see the repository LICENSE.
# Active controllers

Authenticated incoming phone traffic marks that controller active for 90 seconds.
Replaceable snapshots target recent controllers while reliable messages retain
every authorized recipient. A transport with no recent controller falls back to
the complete authorized set for legacy clients and reconnection. Routing never
deletes a pairing or replaces the controller authorization gate.
