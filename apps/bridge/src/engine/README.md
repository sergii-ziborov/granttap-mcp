# GrantTap engine bridge

This module owns the versioned local IPC boundary between the public machine
runtime and the separately distributed GrantTap Engine. `engine-client.ts`
implements bounded length-prefixed framing and a persistent multiplexed Unix
socket. A timed-out request is never retried automatically on the hook-critical
path. `engine-supervisor.ts` keeps rollout opt-in, verifies the configured
binary by SHA-256 before launch, and reports explicit health without changing
legacy hook behavior when the engine is disabled or unavailable.
`engine-projects.ts` forwards only bounded local Project/binding records when
the rollout flag is enabled. Absolute roots stay on the local IPC connection;
the encrypted Mesh projection omits them by default.
Mesh snapshot enrichment queues Weavatrix repository analysis through
`repository-graph-jobs.ts`. One analysis runs at a time, repeated snapshot
ticks reuse a fresh bounded report, and failed analyses back off. An absent
report leaves the graph unavailable and Cortex degraded; it does not block
policy IPC or turn a repository label into an architecture result.
Claude, Codex, and Cursor hooks can evaluate the engine's local Project
Governance policy only when both `GRANTTAP_ENGINE_ENABLED` and
`GRANTTAP_PROJECT_POLICY_ENABLED` are enabled. Project `DENY` and `ASK` precede
bypass, paused gating, and auto-accept. Codex carries ASK from `PreToolUse` to
`PermissionRequest` with a single-use exact-call marker; Cursor evaluates shell
and redacted MCP fingerprints directly. A disabled or unavailable engine
preserves the established GrantTap flow, and no hook request is retried inside
its 2,000 ms policy budget. Repository impact is not computed synchronously in
the hook; unavailable impact remains explicitly unavailable.

`invocation-ingest.ts` reads bounded complete transcript lines and exact-call
hook denial metadata without forwarding tool arguments, output, or reason text.
Cursor decisions without a native call ID stay unattributed. Events are replayed
with stable IDs after an IPC failure. `invocation-query.ts` returns bounded
Engine history to the phone under the Project key, while
`invocation-scope.ts` exposes one Task slice through the caller's existing
opaque Mesh capability. The Engine, not this bridge or Usage telemetry, owns
the durable journal.

The proprietary engine source and Project database do not live in this package.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
