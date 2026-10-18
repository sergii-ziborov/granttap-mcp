# Cursor executions

An interactive ACP execution may have a different native ID from its existing
IDE conversation. This module durably binds that ID to the same GrantTap Task
and workspace. Questions, tool hooks, policy and Task Stop retain the original
Task scope. Reverse aliases are checked against their authoritative Task record.
An existing execution cannot silently be replaced after a failed resume.

The private mapping contains identifiers and a workspace path, never prompts,
provider credentials or transcript text.

License: GrantTap Commercial Source License; see repository-root `LICENSE`.
