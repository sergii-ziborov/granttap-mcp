# Session repository catalog

Public entry point: `index.ts`. The catalog inspects Git facts, joins provider
sessions to stable Tasks, and records endpoint bindings and execution history.

An execution may discover a checkout after its Task started in a non-Git parent
workspace. The catalog retains the Task and Project identity and records the
observed repository on its execution. An observation does not grant Project
membership or prove a code dependency. A local repository without a remote is
bound to the parent folder's Mesh as before; one with its own remote is not
(`local-remote/folder-meshes.ts`), and a binding an older runtime made for it
there is taken out with a removal record. Apple clients partition workspace Tasks
using those observations without moving them between access scopes.

A chat another chat started (`startedBy`) whose folder is no checkout of its
own is placed in its parent's Mesh and binds nothing for its folder; parents are
linked first within a batch
([chats started by another chat](../../started-by/README.md)).

Git facts are shared only within one catalog batch. The next reading refreshes
the root, origin, worktree, and revision, including a workspace which becomes an
empty Git repository before its first commit or later gains an origin. Neither
negative probes nor old repository identities persist across refreshes.

Behavior tests: `tests/agentic/codex-workspace-binding.test.ts` and
`tests/project/project-mesh-core.test.ts`.

## Background Graph admission

`inspectRepositoryAsync` provides the same repository facts without blocking
relay callbacks. Native Git subprocesses are limited to two across the process.
Concurrent inspections of the same path share their in-flight result; a later
inspection verifies the checkout again. Missing Git facts remain unknown.

Tests for asynchronous inspection live in `tests/`; Graph admission also has
`runtime/graph/tests/responsiveness/checkout-inspection.test.ts`.

## License

GrantTap Commercial Source License. See [LICENSE](../../../../../LICENSE).
