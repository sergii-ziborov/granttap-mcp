# Phone message delivery

Public entry: `index.ts`. The handler owns the durable delivery lease and receipt
sequence for non-correlated phone messages. Validation happens before the first
processing receipt, and duplicate validated messages never start another run.
Terminal responses remain correlated to the original message id.

Integration tests: `tests/delivery/processing-receipt.test.ts`; attachment rejection
coverage: `tests/attachment/attachment-uploads.test.ts`. See the monitor README.

This module uses the repository Apache License 2.0.
