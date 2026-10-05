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
A phone observation does not clear a pending QR. Enrollment completes only when
a new endpoint identity is adopted. Expired QR images and copy actions are
removed; Create a new QR or confirmed reconnect can issue a replacement.

The UI initializes the MCP Apps bridge before invoking tools, bounds waits,
checks parent messages, refreshes pending pairing while visible, and keeps
copyable transfer material out of model-visible text and persistent UI storage.
Non-UI clients can still use the tools and display the returned QR image.

Connect with passkey on the card creates a short-lived, authenticated website
request. A fresh passkey assertion on granttap.com links this Mac to the user's
account; the site returns a machine token only to the local MCP watcher, which
saves it privately. The QR pairing room and provider runtime remain unchanged.
The separate coding-app OAuth page can also use passkey to authorize that MCP
client. The Codex-owned plugin management page is not this card.

Tests in `tests/` exercise isolated keys, a loopback encrypted phone connection,
expiry, non-mutating status, and actual DOM button/host-message behavior.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
