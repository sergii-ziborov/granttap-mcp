# Relay state publication

Public entry: `retainedPayloadOptions`. The transport negotiates latest-state
retention before adding its opaque metadata. It retains catalogs, task-key
grants, Mesh snapshots and transcript heads for each approved recipient. Commands,
approval decisions and historical transcript pages never replace a current head.
The relay keeps only ciphertext, bounded by its room capacity and expiry.

Key grants replay first, followed by catalogs, Mesh and heads. Generation times
remain unchanged, so saved work cannot pretend to be a new provider response.
A catalog with historical tasks occupies a separate slot from the active-only
catalog. Current heads are published in fair batches of at most 32 even when no
phone subscribes, independently of catalog and heartbeat publication.

The phone's queue is restored through the separate durable task-job API. Relay
state caching does not execute commands or change provider policy. Older relays
continue using live updates and the existing acknowledged mailbox.

`ledger.ts` remembers which read state each relay connection has already handed
over. A broadcast of exactly that state again (`RelayClient.retainedUnchanged`)
is skipped together with its key grant: the relay keeps the copy and replays it
to joining phones. Without this the monitor resent every Mesh snapshot, plain
and enriched, and every chat head each time a phone asked for a catalog, about
8 MB/s of identical frames that queued its heartbeat and replies behind them.
The three latest copies of a state count as sent, so a Mesh generation's plain and
enriched copies are both recognised. A reply to one phone is never skipped; a
new connection, a newly added phone and five minutes without a change all hand
the state over again.

Tests live in `tests/` and run with the repository's test and release commands.

GrantTap Commercial Source License; see the repository LICENSE.

Opaque group identifiers keep each scoped key with its encrypted snapshots during eviction. Grants for historical pages or other noncached replies are not retained as read state. Oversized read payloads stay live rather than reserving an orphan key slot.
