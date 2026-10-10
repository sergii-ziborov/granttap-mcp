# Project context delivery

Public entry: `project.ts`, used by the Mesh resource renderer.

Compact responses retain Task identity, peer Tasks, file claims, policy restrictions,
source event IDs, bounded history and expansion links. The linked Cortex compiler
may replace repeated evidence with cited packet content only when every visible
event and knowledge record is covered and the complete response is smaller in
both characters and UTF-8 bytes. Otherwise the response exposes compiler status
and an expansion link without appending a duplicate packet. Full and legacy
reads remain explicit expanded views.

Failure reports remain attributed observations. A failed delivered run emits
structured failure data; memory stores an attempt, never a successful result.
Task-private attempts stay private unless an explicitly shared completion exposes
them to the Project. Tests: `tests/context/context-packet.test.ts` and
`tests/mesh/knowledge/failed-run.test.ts`.

License: [MIT License](../../../../../LICENSE).
