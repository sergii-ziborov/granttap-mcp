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

`call-scope.ts` and `capability.ts` own caller identity. The MCP server cannot
see which agent called it, so each provider hook records a single-use
attribution for the exact call it observed inside its own session, and the
runtime derives the publishing execution from that instead of from anything the
model supplied. `capability.ts` mints the opaque per-execution token that
`scoped-view.ts` answers with, so a read returns one Project rather than
everything this computer knows. Structured events use the existing `notify`
tool so the public MCP tool allowlist remains exactly `connect`, `notify`,
`ask_yes_no`, and `ask`. Setup and global provider configuration remain
CLI-only.

`readiness.ts` decides whether a handoff may leave at all. A capsule transfers
committed facts, so uncommitted work blocks the handoff instead of silently
staying behind, and the destination refuses just as explicitly when it lacks the
named commit or when the capsule's resource claims overlap another execution.

Every event is schema-bounded and sent under an independent task key; snapshots
use an independent project key. Resource claims are advisory, expire without a
heartbeat, and a colliding claim is rejected before it is recorded. The agent
may choose other work or ask the current owner; the conflict reaches the human
only after explicit `needsUser` escalation.
