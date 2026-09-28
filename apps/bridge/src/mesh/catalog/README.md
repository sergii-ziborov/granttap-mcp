# Session repository catalog

Public entry point: `index.ts`. The catalog inspects Git facts, joins provider
sessions to stable Tasks, and records endpoint bindings and execution history.

An execution may discover a checkout after its Task started in a non-Git parent
workspace. The catalog retains the Task and Project identity and records the
observed repository on its execution. An observation does not grant Project
membership or prove a code dependency. Apple clients partition workspace Tasks
using those observations without moving them between access scopes.

Git facts are shared only within one catalog batch. The next reading refreshes
the root, origin, worktree, and revision, including a workspace which becomes an
empty Git repository before its first commit or later gains an origin. Neither
negative probes nor old repository identities persist across refreshes.

Behavior tests: `tests/agentic/codex-workspace-binding.test.ts` and
`tests/project/project-mesh-core.test.ts`.

## License

MIT License. See [LICENSE](../../../../../LICENSE).
