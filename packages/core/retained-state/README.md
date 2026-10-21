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

Tests live in `tests/` and run with the repository's test and release commands.

GrantTap Commercial Source License; see the repository LICENSE.
