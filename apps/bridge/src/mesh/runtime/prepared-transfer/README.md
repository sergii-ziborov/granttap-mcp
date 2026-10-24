# Preparing a Task transfer

`prepare.ts` prepares one scoped transfer through the Mesh runtime's public
entry point. `source.ts` checks the source facts and the explicit checkpoint
choice; `index.ts` captures and confirms complete visible context.

A missing source chat sends a scoped `TASK_BLOCKED` result so the controller can
explain the refusal. Preparing does not launch the destination provider. Work
starts when the person sends the prepared chat its first message.

Catalog batches share a working-tree probe for chats in the same checkout.
The next batch reads it again, including unknown results, so this never hides
new uncommitted work behind a persistent cache.

For a chat started above its repositories, `source-binding.ts` first uses the
Task's own execution, current resource claim, Project repository, or sole owned
checkout. Multiple unresolved choices require an explicit `sourceBindingId`.
Both paths stay within the owning endpoint's available Project bindings and
verify the actual Git root and identity before capturing context. A catalog
refresh preserves an established checkout when the native chat still reports
the same parent folder; missing known checkouts never select another repository.
An exact repository binding takes precedence over a Project's parent execution
folder. Preparing keeps the native source folder unchanged and launches no
provider. Rejected preparations also publish their retained Project state.

Capsule status is bounded independently from the complete conversation capture;
a long native summary cannot invalidate an otherwise transferable Git Task.
Local prepared handoffs persist their destination and validated receipt before
publishing to the phone. A blocked socket cannot hold the local preparation
behind a notification. Publication errors retain both durable events for the
next snapshot; they never replay the transfer or start a provider.

Tests: `tests/metadata.test.ts`, `tests/source-checkout.test.ts`,
`tests/mesh/mesh-handoff-safety.test.ts`, and catalog
`tests/working-tree-batch.test.ts`.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
