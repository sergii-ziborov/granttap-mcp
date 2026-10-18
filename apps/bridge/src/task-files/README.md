# Task files

`readTaskWorkspace` reads a directory page or a bounded UTF-8 file from the exact
native execution workspace. It accepts relative paths, resolves symlinks inside
that workspace, and rejects credentials, traversal and external paths. The
viewer performs no writes, shell operations, model calls or provider actions.

`publishTaskWorkspace` resolves the execution through the computer's published
catalog and returns an authenticated task-encrypted reply to the requesting
controller. The local Mac counterpart validates Project, Task and Execution
identity before using the same reader. Directory pages contain at most 200
entries; file previews contain at most 128 KiB and explicitly mark truncation.

Module tests cover real files, nested directories, boundaries and pagination.

This module uses the repository GrantTap Commercial Source License.
