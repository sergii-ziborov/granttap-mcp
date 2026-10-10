# Session image transport

`index.ts` advertises pictures in visible transcript rows and serves bounded
image chunks through the existing Task-encrypted channel. Queries carry an exact
conversation identity and native history cursor, never a filesystem path.
The reader checks the requested image against that conversation's page. Workspace
artifacts retain the desktop reader's execution/workspace checks. Native user
pictures are read only from that conversation's provider transcript.

Unavailable sources produce an explicit reply; they do not change pairing or
account state. Apple clients retain validated original bytes locally and use
their scoped copy when offline. Tests live in `tests/`.

Licensed under the MIT License. See the repository root `LICENSE`.
