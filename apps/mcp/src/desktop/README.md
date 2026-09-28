# Desktop local channel

The local capability usage response includes bounded native session token and
context facts through `projection/session-usage.ts`. Sessions are deduplicated
by provider and native ID; conversation text and paths never enter this payload.
The Apple client keeps local computer identity when applying these observations.

`engine-bridge.ts` is the MCP-owned, same-user Unix-socket entry point for the
native Mac app. Its path is announced by the loopback `/desktop/status` response.
The socket and its private parent directory are created at runtime and removed
when the HTTP helper stops. The bridge accepts one bounded operation per
connection. Arbitrary Engine writes and approval actions are excluded. A local
Task send requires an exact persisted Mesh, Task, and native Execution link.
Scoped policy and auto-accept operations require a persisted Mesh binding to the
local endpoint and use the canonical policy/configuration runtime.

`project-catalog.ts` reads the MCP-owned local Project Mesh registry when an
installed Engine does not provide `project.list`. `mesh-project.ts` supplies
bounded Task title, state, provider, and open Execution activity facts without
returning Task goals, prompt text, pairing material, or credentials.
`task-activity.ts` resolves one Task's exact native Execution link and returns
a bounded conversation. `task-activity-runner.ts` runs transcript parsing in a
 separate process with a deadline so it cannot stall the HTTP helper. Engine policy,
Knowledge, graph, and invocation reads remain Engine responses.

Tests are in `../../../../tests/http/desktop-engine-bridge.test.ts`.

This MCP component is covered by the repository [MIT License](../../../../LICENSE).
