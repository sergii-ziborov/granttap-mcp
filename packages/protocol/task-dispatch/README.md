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

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.

## Pending native chats

`user.message.continue` names an original creation ID and has no native session
ID or workspace override. MCP 0.8.75 resolves it using the authenticated sender
and room before normal provider and Project validation. Older receivers reject
the unknown operation; it can never be interpreted as a new task.
