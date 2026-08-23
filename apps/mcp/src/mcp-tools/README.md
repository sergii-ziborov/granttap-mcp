# MCP tools

The Personal MCP surface is an exact allowlist: `connect`, `notify`,
`ask_yes_no`, and `ask`. `relay.ts` owns one shared encrypted relay connection
and the durable question lifecycle. Machine setup, custom relay selection, and
pairing reset are explicit CLI operations and cannot be invoked by the model.

`mesh-resource.ts` publishes the read-only `granttap://mesh/current` resource for
that same surface, and `notify` may alternatively carry one bounded task-scoped
Mesh event. Neither adds a fifth public tool.

`mesh-tools.ts`, `mesh-actions.ts`, and `mesh-relay.ts` serve the separate scoped
server started by `granttap internal mesh-mcp` for a connected Grok Bot endpoint.
It exposes only the twelve task-scoped Mesh operations, re-authorizes endpoint,
credential, policy revision, expiry, actor, Project scope, and operation on every
call, and can never create invites, expand scope, change the relay, or reach
`setup`.
