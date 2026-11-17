# Safe shell admission

`safe-shell.ts` is the implementation entry point for the narrow local shell
grammar used by Cursor's safe auto-accept path. Unrecognized options and shell
syntax require a decision. The Project policy and machine-level deny still run
before this legacy auto-accept check.

`temp-removal.ts` decides when `rm -rf` is ordinary work rather than a destructive action: every
`rm` in the command starts its own simple command, takes only `-r`, `-R`, `-f` or `-v`, and names
literal absolute paths whose real parent folder lies inside `/tmp`, `/private/tmp` or the system
temp folder. Variables, command substitution, globs, quotes other than plain single quotes, `..`,
`.`, a trailing slash, a redirection, the temp root itself, a missing parent folder or a parent
reached through a symbolic link out of the temp folder make it destructive again, so "All except
push" still asks. `sudo` and the other destructive patterns are unaffected. The approval's risk
tag follows the same rule.

See [the policy module](../README.md) and the repository engineering index.

License: this module is distributed under the GrantTap Commercial Source License in the repository-root
`LICENSE` file.
