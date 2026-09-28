# Session repository catalog

Public entry point: `index.ts`. The catalog inspects Git facts, joins provider
sessions to stable Tasks, and records endpoint bindings and execution history.

An execution may discover a checkout after its Task started in a non-Git parent
workspace. The catalog retains the Task and Project identity and records the
observed repository on its execution. An observation does not grant Project
membership or prove a code dependency. Apple clients partition workspace Tasks
using those observations without moving them between access scopes.

Negative Git probes are not cached. A workspace which becomes a Git repository,
including an empty checkout before its first commit, is recognized on the next
catalog reading. Confirmed checkout identities are cached while revisions are
refreshed.

Behavior tests: `tests/agentic/codex-workspace-binding.test.ts` and
`tests/project/project-mesh-core.test.ts`.
