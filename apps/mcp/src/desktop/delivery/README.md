# Desktop attachment delivery

Task sends and creation retain the exact persisted Project/Task/Execution or
repository binding admission. The native client may supply `attachments_json`,
a small manifest of filename, MIME type and paths in one private temporary batch.
`readDesktopAttachments` reads numeric files only from a same-user, mode-700
`granttap-message-*` directory directly under the OS temporary root. Files must
be regular, mode-600, non-symlink files. Ten files, 6 MB each, 11 MB total are the
same limits as encrypted phone messages. Invalid batches are rejected rather
than silently losing files. The existing provider attachment pipeline stages
images and arbitrary documents; the native client removes its batch after reply.

`desktop.task_handoff` accepts a bounded handoff request from the authenticated
Mac desktop channel. It verifies the exact owning local execution, then asks the
canonical Mesh runtime to prepare the encrypted Task Capsule. A destination
model and user comment are carried with the Task, including for another computer.

Tests: `tests/desktop/desktop-task-send.test.ts`,
`tests/desktop/delivery/task-handoff.test.ts`, local `tests/attachments.test.ts`.
Parent: [Desktop local channel](../README.md).

This MCP component is covered by the repository [MIT License](../../../../../LICENSE).
