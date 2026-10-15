# Encrypted relay transport

Public entry: `RelayClient` in `relay-client.ts`. Machine and phone endpoints
seal every payload for an authorized peer. `relay-inbound` authenticates routing,
peer keys and optional per-task encryption before a consumer receives content.
The relay sees routing metadata and opaque ciphertext only.

Ordinary consumers return true only after durable application acceptance.
`RelayMessageAcceptance` binds replay protection to ciphertext, including across
process restarts, rather than trusting a clear delivery ID. Transport ACKs are
separate from provider message acceptance.

The `task-dispatch` entry handles negotiated relay job offers. Scheduling and job
identity must match the encrypted `task.dispatch` body. Those jobs never enter
ordinary listeners; a registered durable consumer must persist and claim them
through the task-job API before executing. Register before connecting to
advertise machine support. Declining or throwing leaves the relay job pending.

Tests: `tests/core/core-relay-client.test.ts`, local task-dispatch tests, and
`packages/protocol/task-dispatch/tests`.

## License

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
