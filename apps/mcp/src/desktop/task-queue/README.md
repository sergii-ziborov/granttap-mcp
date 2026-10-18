# Native desktop task queue

Public entry: `desktopTaskQueue` in `index.ts`, exposed as `desktop.task_queue`
through the authenticated same-user desktop bridge. Put, status and cancel are
confined to an exact persisted Project, Task, native execution and local endpoint.
The machine runtime persists and encrypts the operation before asking the relay
to store it. It continues retrying an unconfirmed upload when the app closes.

Large attachments use the existing bounded private native batch manifest. No
pairing keys, relay credentials or plaintext queue contents are returned. Current
computer policies remain authoritative when the receiver starts a queued turn.

Tests: `tests/scope.test.ts` and bridge task-dispatch sender/receiver tests.
Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
