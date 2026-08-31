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
The Claude hook can evaluate the engine's local Project Governance policy only
when both `GRANTTAP_ENGINE_ENABLED` and `GRANTTAP_PROJECT_POLICY_ENABLED` are
enabled. Project `DENY` and `ASK` precede bypass and auto-accept. A disabled or
unavailable engine preserves the established GrantTap flow, and no hook request
is retried inside its 50 ms policy budget.

The proprietary engine source and Project database do not live in this package.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
