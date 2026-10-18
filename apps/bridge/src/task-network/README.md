# Project computer transport

`TaskNetworkStore` owns controller-issued, revisioned Project peer grants.
`runtime` accepts configuration for this endpoint only after authenticating the
paired controller and finding its authorized local Project checkout. Peer keys
never join the controller list. Revocation is rechecked before preparation.

`transport/receive.ts` accepts only authenticated `mesh.task.dispatch` jobs from
the exact Project writer. Normal phone/controller decoding stays separate.
`storage` fsyncs immutable outgoing ciphertext and incoming requests before a
relay claim. A stable claim ID and one preparation owner fence duplicate workers.
An encrypted result is saved before finishing the relay job; a lost response
retries that result instead of preparing or forwarding native work again.

The receiver prepares a destination through an idempotent port. It does not
grant general computer control or directly run arbitrary provider operations.
Forwarded work must use the existing durable native queue with a stable child ID.
Full contexts retire after relay confirmation; receipt metadata remains private.

`source` persists immutable ciphertext, saves a pending source guard, and
reconfirms the visible conversation before enabling upload. The persistent
monitor resumes admitted transfers after a CLI exits. Only an authenticated
destination result with the selected execution, provider and computer can
confirm a transfer. Recovery restores pruned request metadata transactionally
without superseding a newer transfer. Phone notifications contain capsule
evidence; they do not forward the private conversation again.

Scoped writer expiry stops new work. The writer can read only its own retained
job metadata for seven more days; revocation immediately stops new work and resource reads. Only the writer’s own retained job metadata remains readable for seven days after revocation, so an already prepared transfer can recover its authenticated receipt.

Tests exercise real encryption, scope and revocation, restart and immutable retry,
owner fencing, result recovery, context retirement and policy changes before work.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
