# Desktop Task controls

`desktopTaskControl` admits pause, resume and Codex context compaction only for
one exact persisted Project/Task/native session on this computer. The authenticated
desktop channel is required. `localTaskSession` is also used for immediate sends.
It refuses ambiguous native IDs and executions on another computer.

`desktopTaskPreferences` reads and changes only that Task's approval rule, provider
access and existing capability switches. Approval changes go through the canonical
configuration command and revision-bound Task automation grant. Global and Project
denies remain enforced by the existing hooks and Engine. No global policy is changed.
The response contains the effective rule, hold and access, with a generation time.

`desktop.task_capabilities` discovers bounded MCP and Skill catalogs in the parsing
worker. Provider CLI discovery cannot block the HTTP/policy event loop or Stop.
The client loads the conversation before requesting this catalog and retains the
catalog across lightweight live refreshes.

Pause, resume and compaction share `bridge/src/task-control` with phone relay
commands. A stop confirms a durable tool-call hold and requests process interruption;
it does not claim that native process exit has already been confirmed.

Tests in `tests/` exercise a real synthetic child process, durable settings and
foreign execution rejection. Parent: [Desktop channel](../README.md).

Covered by the [GrantTap Commercial Source License](../../../../../LICENSE).
