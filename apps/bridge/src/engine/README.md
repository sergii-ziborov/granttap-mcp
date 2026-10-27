# GrantTap engine bridge

This module owns the versioned local IPC boundary between the public machine
runtime and the separately distributed GrantTap Engine. `engine-client.ts`
implements bounded length-prefixed framing and a persistent multiplexed local
socket or Windows named pipe. A timed-out request is never retried automatically
on the hook-critical path. `engine-supervisor.ts` verifies the configured
binary by SHA-256 before launch, and reports explicit health without changing
legacy hook behavior when the engine is disabled or unavailable.
`engine-projects.ts` forwards only bounded local Project/binding records when
the rollout flag is enabled. Absolute roots stay on the local IPC connection;
the encrypted Mesh projection omits them by default.
Provider timestamps may contain fractions of a millisecond. Binding admission
converts them to nonnegative safe integer milliseconds at the Engine IPC
boundary, matching Rust's `u64` contract. The original Project and provider
observations retain their precision; invalid epochs cannot update a binding.
Mesh snapshot enrichment queues Weavatrix repository analysis through
`repository-graph-jobs.ts`. One analysis runs at a time, repeated snapshot
ticks reuse a fresh bounded report, and failed analyses back off. An absent
report leaves the graph unavailable and Cortex degraded; it does not block
policy IPC: repository analysis owns a separate bounded-lifetime socket, while
policy and Backbone requests keep their control connection. It does not turn a repository label into an architecture result.
Explicit builds join and prioritize the same pending repository job. Confirmed
reports are retained in a bounded private computer cache across restarts, served
while a new observation runs, and refreshed after the observation expires. Git
admission revision (`sourceRevision`) remains separate from Weavatrix's content
fingerprint (`revision`). Failed analyses cannot erase the durable last report.
Explicit Graph builds also invoke the Engine's `graph.analyze_project` for two
to eight admitted local repositories. The projection labels these shared static
contracts and keeps their runtime destination unverified. They do not become
verified Backbone dependencies or merge Project grants. The Apple Silicon
artifact pins Engine 0.1.5 with Weavatrix 2.17.5, injective package import identities
and per-file function extent reuse during metrics analysis; unsupported Engine operations
leave this analysis unavailable. See `runtime/project-relationships/README.md`.

Claude, Codex, and Cursor hooks can evaluate the engine's local Project
Governance policy only when both `GRANTTAP_ENGINE_ENABLED` and
`GRANTTAP_PROJECT_POLICY_ENABLED` are enabled. Project `DENY` and `ASK` precede
bypass, paused gating, and auto-accept. Codex carries ASK from `PreToolUse` to
`PermissionRequest` with a single-use exact-call marker; Cursor evaluates shell
and redacted MCP fingerprints directly. A disabled or unavailable engine
preserves the established GrantTap flow, and no hook request is retried inside
its 2,000 ms policy budget. For an identified Task write, the hook asks the
already-persisted graph for heads and a bounded impact result. It reports
impact available only when Task head, repository revision, path and completeness
match; it never scans a repository on the hook path. Unknown impact remains
explicitly unavailable.

`invocation-ingest.ts` reads bounded complete transcript lines and exact-call
hook denial metadata without forwarding tool arguments, output, or reason text.
Cursor decisions without a native call ID stay unattributed. Events are replayed
with stable IDs after an IPC failure. `invocation-query.ts` returns bounded
Engine history to the phone under the Project key, while
`invocation-scope.ts` exposes one Task slice through the caller's existing
opaque Mesh capability. The Engine, not this bridge or Usage telemetry, owns
the durable journal.

The proprietary engine source and Project database do not live in this package.

Every CLI entry point loads the persisted Engine declaration before importing
its runtime. The monitor, HTTP MCP and provider hooks therefore share activation
on macOS, Linux and Windows rather than relying on a LaunchAgent environment.
Explicit disablement and a complete explicit executable/checksum pair win over
the saved declaration. Partial environment overrides are never mixed with a
different file's checksum. The supervisor still verifies the executable's bytes
before launch. Its child process receives a minimum 32 MiB Rust worker stack: the default stack aborts the native parser on long, valid Rust syntax trees. Larger explicit reserves are retained. The parent process environment, Engine enablement and project policy settings are unchanged. This is a worker stack reserve, not a scan timeout or a guarantee that arbitrary inputs cannot exhaust resources. Windows clients derive a local named pipe from the normalized
configuration path; remote shares never become Engine endpoints.
The paired monitor installs the pinned managed Engine in the background when
needed. Catalog delivery does not await that download. Failed preparation retries
without losing phone questions, and a restarted helper re-admits verified local
checkouts. Explicit disablement and custom declarations are preserved.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
