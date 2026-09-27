# Safe shell admission

`safe-shell.ts` is the implementation entry point for the narrow local shell
grammar used by Cursor's safe auto-accept path. Unrecognized options and shell
syntax require a decision. The Project policy and machine-level deny still run
before this legacy auto-accept check.

See [the policy module](../README.md) and the repository engineering index.

License: this module is distributed under the MIT License in the repository-root
`LICENSE` file.
