# Cursor visible conversation

`index.ts` records visible messages from GrantTap-owned ACP turns and publishes
the same Task in the catalog before its first question. IDE continuations keep
their original Task identity and native messages. `history.ts` reads bounded,
Task-bound pages from the private append-only archive. Metadata includes the
current visible partial answer so reopening during a turn also works.

Thought chunks, diagnostics, native history replay, credentials, raw tool inputs
and capability-use guesses are not recorded. Existing measured usage remains
separate. A later turn cannot be overwritten by an older turn's updates.

License: GrantTap Commercial Source License; see repository-root `LICENSE`.
