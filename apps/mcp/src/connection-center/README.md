# Connection center

`../mcp-tools/connect.ts` registers the public `connection_status`, `connect`,
and confirmed `reconnect` tools. `state.ts` owns the process-local pending QR
and sanitized connection snapshot. `../mcp-tools/connection-widget.ts` serves
`widget.html`, `bridge.js`, and `view.js` as a self-contained MCP Apps resource.

Opening the center does not create keys, start a relay connection, or install
hooks. Connect preserves an existing machine identity, including when the local
phone export is absent. Reconnect requires explicit confirmation. A pending QR
is reusable until expiry in this MCP process; restarting the process loses the
transfer code but preserves the pairing. It never persists transfer secrets.

Saved keys, this process's relay socket, and recent authenticated phone messages
are distinct. Unknown phone availability stays unknown. Provider readiness is
configuration information, not evidence that the provider is currently running.
A phone observation clears the pending QR. Expired QR images and copy actions
are removed; reconnect can issue a replacement after confirmation.

The UI initializes the MCP Apps bridge before invoking tools, bounds waits,
checks parent messages, refreshes pending pairing while visible, and keeps
copyable transfer material out of model-visible text and persistent UI storage.
Non-UI clients can still use the tools and display the returned QR image.

The local stdio plugin does not have a separate account login. The Codex-owned
plugin management page is not this UI. Its native OAuth sign-in controls apply
to OAuth-capable HTTP MCP servers; this module does not add an account service
or replace the local provider runtime.

Tests in `tests/` exercise isolated keys, a loopback encrypted phone connection,
expiry, non-mutating status, and actual DOM button/host-message behavior.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
