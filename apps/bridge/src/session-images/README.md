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

Licensed under the Apache License 2.0. See the repository root `LICENSE`.

Native image identities remain readable after the chat head advances. Codex
attachments are located by timestamp and content block together, so a caption
with the same timestamp cannot hide the picture. Original bytes are delivered in
bounded encrypted chunks and the Apple client retains them for offline use.

An authenticated image query returns its key grant and chunk only to the requesting controller. Shared chat publication still retains every authorized controller, including one receiving passively.

Saved native picture identities remain addressable after newer transcript pages append. Lookup walks bounded windows toward the original row, verifies the exact conversation and block identity, and stops at the file start or a non-advancing cursor. There is no page-count expiry for a previously advertised attachment.

Workspace screenshots in older replies resolve the original native row and its exact advertised image identity before applying the existing Task, Execution and workspace access checks. A request never supplies a filesystem path, and looking up an older reply does not widen access outside its authorized workspace.
