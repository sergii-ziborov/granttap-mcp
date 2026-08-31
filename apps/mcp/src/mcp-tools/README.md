# MCP tools

The Personal MCP surface is an exact allowlist: `connect`, `notify`,
`ask_yes_no`, and `ask`. `relay.ts` owns one shared encrypted relay connection
and the durable question lifecycle. Machine setup, custom relay selection, and
pairing reset are explicit CLI operations and cannot be invoked by the model.

`mesh-resource.ts` publishes the Mesh resources for that same surface, and
`notify` may alternatively carry one bounded task-scoped Mesh event. Neither
adds a fifth public tool.

Both are caller-scoped. `granttap://mesh/current` returns no Project data;
`granttap://mesh/{capability}` returns only the calling execution's Project,
Task, owners, claims, dependencies, and relevant events. A `notify` Mesh event
is published for the session its provider hook attributed, never for a session
the model named, and ownership-transfer event types are refused outright.

`mesh-tools.ts`, `mesh-actions.ts`, and `mesh-relay.ts` serve the separate scoped
server started by `granttap internal mesh-mcp` for a connected Grok Bot endpoint.
It exposes only the twelve task-scoped Mesh operations, re-authorizes endpoint,
credential, policy revision, expiry, actor, Project scope, and operation on every
call, and can never create invites, expand scope, change the relay, or reach
`setup`.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
