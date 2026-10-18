# Durable task receiver

Public entry: `index.ts`. `TaskDispatchInbox` preserves the complete authenticated
operation, inline images and controller identity before a relay claim. Private
files use restrictive permissions, checksums, fsync and an append-only phase
journal. A partial trailing journal write never erases the last complete state.

`worker/index.ts` waits for readiness, claims on the relay immediately before a
native submission and persists a unique attempt first. Duplicates cannot reset
the attempt. A successful native result is saved before its separate completion
request. After confirmed completion or cancellation, the receiver removes the
full operation and photos, keeping only a private, minimal idempotency receipt
until expiry plus seven days. Restarting after an ambiguous submission requires confirmation instead
of blindly replaying the prompt. Queued server cancellation wins over a stale
local offer. Scheduling does not imply that the controller phone is online.

Tests live in `tests/` and `worker/tests/` and use synthetic operations and private
temporary directories. This module does not grant provider or project access.

An authenticated `deliveryMode: immediate` is an explicit controller release.
It takes precedence over waiting follow-ups and skips the idle requirement only;
pause, an in-flight native submission and provider policy still win. Normal jobs
use a catalog observed within 60 seconds rather than rescanning all native logs
for every pending message on each receiver tick.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
