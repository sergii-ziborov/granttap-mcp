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

Status also carries, read without writing: a summary sorting the paired phones by when each
last reached this computer, then one line per phone with its label and last-seen time, and how many
were not seen for 30 days, the cue for `remove_phones` (keys stay paired until someone removes them, so
old test installs stay listed). Each structured phone carries `id`, `label`, `primary` and `addedAt`; `pendingUpdate`, a newer runtime this computer holds and why it is not running yet;
and `chat`, for the chat named in this server's environment (Claude Code's
`CLAUDE_CODE_SESSION_ID`), the phone messages queued to reach it after its turn and whether it
continues by itself after a subscription limit. Hosts that name no chat get `chat: null`; none is
guessed. `../status/chat-status.ts` assembles the chat part.

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
The card keeps reauthorization available for an already linked Mac and reads
the one-time URL from structured tool output when a host omits MCP metadata.
The separate coding-app OAuth page can also use passkey to authorize that MCP
client. The Codex-owned plugin management page is not this card.

The Automatic updates switch calls `set_runtime_auto_update` with an explicit
boolean and displays the confirmed persisted result from the server. The setting
is computer-wide for the GrantTap runtime; marketplace plugin updates stay under
the coding app's control. A service environment override locks it off. Failed
saves do not optimistically change the switch. Pairing and capability policy are
stored separately and preserved.

Tests in `tests/` exercise isolated keys, a loopback encrypted phone connection,
expiry, non-mutating status, and actual DOM button/host-message behavior.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
