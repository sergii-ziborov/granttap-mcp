# Project Mesh runtime

This module links discovered native sessions to stable Project and Task
identities, persists bounded structured events, tracks expiring resource
claims and dependencies, and executes authorized task handoffs.

`runtime.ts` is the public runtime entry point. `catalog.ts` derives repository
identity without replacing provider-native session discovery. `store.ts`
deduplicates replayed events and expires stale claims. `capsule.ts` reads only
explicit git and task facts; transcripts and hidden reasoning are never copied.
`worktree.ts` creates a separate target branch/worktree before Claude Code or
Codex is started. Cursor has trusted caller attribution but no phase-one remote
start. Grok Build remains observable and Experimental; because it has no
trusted caller hook, agent-authored scoped Mesh events are not offered for it.
Unsupported paths fail closed.

`call-scope.ts` and `capability.ts` own caller identity. The MCP server cannot
see which agent called it, so supported provider hooks record a single-use
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
"Uncommitted" is read from `git status` including untracked files, because an
untracked file is work no commit would carry. A probe that cannot answer
publishes `unknown`, and only an explicit `clean` releases the handoff.

`convergence.ts` and `task-state.ts` keep one Task identity while snapshots and
events arrive late, twice, and from several computers. Every writer raises the
Task `revision`, a merge keeps the higher one, and a tie resolves the same way
on every device. Ownership only moves forward: to an unowned Task, back to the
session that already owns it, or through a receipt from the current owner —
and a computer that already watched a session hand the Task on refuses that
session's later receipt. Completed and failed Tasks absorb events instead of
reopening, an execution closed by a receipt stays closed even while its native
session keeps reporting itself, and the local catalog may refresh a Task's
description but never take it back from the agent that owns it now.

Every event is schema-bounded and sent under an independent task key; snapshots
use an independent project key. Resource claims are advisory, expire without a
heartbeat, and a colliding claim is rejected before it is recorded. The agent
may choose other work or ask the current owner; the conflict reaches the human
only after explicit `needsUser` escalation.

Project Governance is a separate bounded record stream rather than Mesh
snapshot state. The monitor accepts only project-scoped policy-set records,
applies them to the local Rust engine, publishes one truthful coverage ACK per
installed provider, and periodically projects the canonical policy plus current
coverage back to the phone. Engine or feature unavailability leaves existing
GrantTap behavior intact; strict fail-closed decisions remain on the hook path.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
