# Durable task wire contract

`TaskDispatch` in `index.ts` is the encrypted scheduled-operation wrapper exported
through the public protocol schema. It carries the immutable job ID, receiver
acceptance token, execution window and correlated user message or new task.
An existing-chat operation retains its exact session encryption scope.

Approval replies, configuration changes and transient attachment references
cannot be queued. Required files travel inline inside the encrypted operation.
The receiver checks the signed fields against the relay offer before durable
admission. The token is never stored in plaintext on the relay.

Tests live in `tests/wire.test.ts`.

## License

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
