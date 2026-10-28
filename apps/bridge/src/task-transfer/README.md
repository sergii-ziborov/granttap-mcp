# Prepared task transfers

Public entry: `index.ts`. Preparing a destination persists the stable Task,
original title, isolated worktree, provider/model and complete visible context.
It does not invoke an agent. The first user message creates one native execution;
subsequent messages resume that execution behind the stable prepared chat id.

The private context file is checksummed and survives process restart. Missing or
oversized context refuses preparation instead of silently dropping history.
A launch is recorded before invoking the provider. An interrupted first launch
requires inspection and cannot automatically create a second native execution.

Native catalog sweeps never close a prepared alias. The catalog can repair an
older false closure from the retained accepted receipt and checksummed, unstarted
preparation. It does not supersede a later transfer, reopen completed work, or
invent consent to resume the source. Existing Task ownership, the accepted
receipt, and a newer live observation keep availability through delayed snapshot
merges without changing the persisted execution format.

Tests: `tests/prepared.test.ts` covers preparation, restart, model/effort forwarding,
context persistence, stable catalog identity and ambiguous first submissions.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.

The first Grok turn binds its confirmed native session before the final answer,
so the transferred Task can publish live native history while the turn runs.
The durable launch remains in progress and cannot start another execution.

Repeated Grok and Cursor transfers resolve the admitted native execution and
carry every inherited context page before the current visible native history.
Grok capture reads the persisted restore transcript, preserving history across
model-context compaction; incomplete native input refuses a partial transfer.

Provider-readable text and images are regenerated from the checksummed archive
inside `workspaces/task-context`, outside the source checkout and trust-state
directory. Existing workspace tool policy applies; pairing keys, policy and the
authoritative archive remain protected. `tests/provider-context.test.ts` covers
read access, mixed protected paths and regeneration after provider-side edits.
