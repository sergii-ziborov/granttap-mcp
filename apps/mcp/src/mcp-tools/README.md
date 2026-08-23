# MCP tools

The Personal MCP surface is an exact allowlist: `connect`, `notify`,
`ask_yes_no`, and `ask`. `relay.ts` owns one shared encrypted relay connection
and the durable question lifecycle. Machine setup, custom relay selection, and
pairing reset are explicit CLI operations and cannot be invoked by the model.
