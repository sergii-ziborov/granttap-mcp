# Invocation delivery recovery

Public entry: `index.ts`. Retains the unconfirmed suffix of a bounded transcript
batch across IPC failures, preserving exact event identity and source cursors.
Transient errors use exponential backoff; a full journal waits five minutes.
No durable history is deleted or silently replaced to recover capacity.

Behavior is exercised through the ingestor by
`tests/invocation/recovery/ingest.test.ts`.

License: GrantTap Commercial Source License in the repository-root `LICENSE`.
