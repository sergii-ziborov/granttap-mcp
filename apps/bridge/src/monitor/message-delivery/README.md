# Phone message delivery

Public entry: `index.ts`. The handler owns the durable delivery lease and receipt
sequence for non-correlated phone messages. Validation happens before the first
processing receipt, and duplicate validated messages never start another run.
Terminal responses remain correlated to the original message id.

`acceptance.ts` decides when a phone message counts as delivered: when the agent
has taken it, not when its whole turn ends. Tests live in `tests/acceptance.test.ts`.

Integration tests: `tests/delivery/processing-receipt.test.ts`; attachment rejection
coverage: `tests/attachment/attachment-uploads.test.ts`. See the monitor README.

This module uses the repository GrantTap Commercial Source License.

Replies and receipts target the requesting controller. A provider refusal after
the processing acknowledgement emits a rejected receipt and retains that final
outcome across ciphertext retries; it never silently turns back into accepted.
