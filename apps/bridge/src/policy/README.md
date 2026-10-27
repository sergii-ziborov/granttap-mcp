# Effective action policy

`effective-action.ts` is the public implementation entry point for combining
the private engine's Project decision with the existing provider/session flow.
It resolves only already-known local Project state and uses the shared bounded
Engine policy IPC deadline (currently 2,000 ms). When Engine cannot answer for
a previously governed Project, policy asks rather than silently allowing the
action. A never-governed Project preserves the established GrantTap behavior.
This policy timeout is not a phone message delivery timer.

`capability-fingerprint.ts` turns provider tool metadata into a bounded
capability fingerprint. It never copies raw tool arguments, commands, secrets,
or absolute file paths into the fingerprint. Project `DENY` and `ASK` are parent
boundaries; legacy bypass, paused gating, and auto-accept may run only after an
`ALLOW` or `INHERIT` result.

Codex `PreToolUse` never waits for a phone. A Project `ASK` creates an owner-only
30-second marker bound to the exact session, `tool_use_id`, tool, and normalized
argument hash. `PermissionRequest` atomically consumes that marker once and
forces the existing GrantTap approval path. Cursor evaluates Project policy
directly in its shell and MCP hooks; MCP evidence contains only bounded names,
transport, and a configuration SHA-256, never the descriptor or call arguments.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
