# Project Mesh runtime

This module links discovered native sessions to stable Project and Task
identities, persists bounded structured events, tracks expiring resource
claims and dependencies, and executes authorized task handoffs.

`runtime.ts` is the public runtime entry point. `catalog.ts` derives repository
identity without replacing provider-native session discovery. `store.ts`
deduplicates replayed events and expires stale claims. `capsule.ts` reads only
explicit git and task facts; transcripts and hidden reasoning are never copied.
`worktree.ts` creates a separate target branch/worktree before Claude Code or
Codex is started. The provider abstraction already admits Cursor and Grok Build
without changing the core contract, while their unsupported phase-one start
paths fail closed.

The read-only MCP resource `granttap://mesh/current` exposes compact local state
to an agent. Structured events use the existing `notify` tool so the public MCP
tool allowlist remains exactly `connect`, `notify`, `ask_yes_no`, and `ask`.
Setup and global provider configuration remain CLI-only.

Every event is schema-bounded and sent under an independent task key; snapshots
use an independent project key. Resource claims are advisory, expire without a
heartbeat, and a colliding claim is rejected before it is recorded. The agent
may choose other work or ask the current owner; the conflict reaches the human
only after explicit `needsUser` escalation.
