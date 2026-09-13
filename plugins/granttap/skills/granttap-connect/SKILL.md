---
name: granttap-connect
description: Connect, reconnect, or pair this computer with GrantTap. Use when the user asks to install GrantTap, connect an agent, check the pairing, or show a GrantTap QR.
---

# Connect GrantTap

For status, login, connection controls, or diagnostic requests, call
`connection_status` first. It is read-only and opens the connection center:
computer name, runtime version, saved pairing, observed relay/phone activity,
provider readiness, Connect, Refresh, and confirmed Reconnect controls.

Codex, Claude Code, Cursor, and Grok Build use the same local OAuth HTTP
service. Their MCP authorization control opens `granttap.com/connect` with a
one-time iPhone QR when this computer is unpaired.
If already paired, approving an app's access needs no new QR. The page offers a
separate, explicitly confirmed reconnect to replace the phone pairing and
show a new QR. GrantTap has no account/password; provider authentication is
separate.

For a new pairing or QR request, call `connect`. It returns the current one-time
QR while it is valid and never replaces a saved pairing. A saved pairing is not
proof that the phone is online. Expired or lost QR codes require a confirmed
reconnect; never rotate keys silently.

Show the returned QR image directly in the conversation. Do not expose, repeat,
log, or summarize the pairing URI or manual token in additional prose.

Do not reset or replace a healthy pairing just to display a QR. If `connect`
reports that the pairing was reused, explain that no new QR is needed.

For reconnect requests, obtain the user's explicit confirmation that replacing
the current pairing is intended, then call `reconnect` with `confirmed: true`.
Never infer that confirmation from an unrelated connect or status request.

Every coding-app integration requires the durable local OAuth service. If it is missing,
run `npm install --global granttap-mcp@0.8.11` and `granttap setup`, then
retry authorization in the coding app. Provider authentication remains separate
from GrantTap pairing.
