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

Which Node reads a Codex hook does not decide whether it is installed: the
monitor and the MCP server a chat starts can run on different Node versions, and
the hook names the one setup ran on. `hookNodeAccepted` takes any existing
executable named `node` (`node.exe` on Windows) given by an absolute, quoted
path, the stable link included; a path that is gone or names another program is
not accepted. Every other check stands: the route, the exact shape setup writes,
and a launcher that is this runtime or a valid cached one not newer than it
(`hookLaunchesRuntime`). Setup leaves such a command as written, so the trust
Codex keeps for that exact command is not voided.

Public entries: `publishStableNode`, `hookNodeCommand`, `hookNodeAccepted` and
`hookLaunchesRuntime`. Windows gets no link.
A storage failure never stops the monitor from starting. Tests run the published
link and cover replacement, Windows, and an unwritable folder;
`tests/install/codex-hook-node.test.ts` reads a hook set up under another Node.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
