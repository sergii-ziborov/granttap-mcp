# Desktop Mesh policy

`index.ts` implements `desktop.policy_status` and `desktop.policy_set` through
the existing Project policy runtime. `scope.ts` requires a persisted Mesh and an
available local endpoint binding. Writes validate the bounded wire request and
the next revision before reaching the Engine; revision conflicts return the
canonical rejection and status. Reads may retry once after a transient Engine
failure. Writes are never retried automatically.

`auto-accept.ts` implements `desktop.project_auto_accept` through the normal
revisioned configuration command. It changes only the selected Mesh and reports
the actual value plus the computer's paused state. Global policy is preserved.

Tests are in `tests/desktop/policy`. See the desktop module and repository
engineering contract for the local channel and quality boundaries.

This MCP component is covered by the repository [MIT License](../../../../../LICENSE).
