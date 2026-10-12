# Task workspace reader

`desktopTaskWorkspace` admits a Project, Task and exact native Execution before
reading its recorded workspace through the shared `task-files` public entry.
It exposes paged directory listings and bounded UTF-8 previews, with no writes.
Tests live in `../models/tests/task-workspace.test.ts`.

This module uses the repository MIT License.
