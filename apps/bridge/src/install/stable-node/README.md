# Stable Node link

Coding apps started from the Dock inherit a PATH without nvm and similar version
managers, so the Claude Code plugin's `node` command may not resolve there. The
monitor always runs under a working Node and publishes it at `bin/node` in the
private GrantTap configuration folder. The plugin appends that folder to the end
of its PATH, so a Node already on PATH still wins.

Codex's user hooks run outside that plugin environment. Their installed commands
name the working Node executable by absolute path. Setup repairs older commands
that require `node` on PATH; the changed definitions require native hook review.
The launcher path can still survive runtime updates when the Node command is
unchanged. Other providers keep their existing hook definitions.

Public entries: `publishStableNode` and `hookNodeCommand`. Windows gets no link.
A storage failure never stops the monitor from starting. Tests run the published
link and cover replacement, Windows, and an unwritable folder.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
