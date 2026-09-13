---
name: granttap-connect
description: Connect, reconnect, or pair this computer with GrantTap. Use when the user asks to install GrantTap, connect an agent, check the pairing, or show a GrantTap QR.
---

# Connect GrantTap

For status, login, connection controls, or diagnostic requests, call
`connection_status` first. It is read-only and opens the connection center:
computer name, runtime version, saved pairing, observed relay/phone activity,
provider readiness, Connect, Refresh, and confirmed Reconnect controls.

GrantTap's local stdio plugin has no account/password sign-in. Pairing with the
iPhone authorizes this computer. Do not claim a native OAuth login button exists
on the Codex plugin page. Provider authentication is separate.

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

Plugin installation registers the MCP server for this agent. If the user also
wants provider hooks or the background helper repaired, tell them to run
`npx -y granttap-mcp@0.8.9 setup` locally. Provider authentication remains
separate from GrantTap pairing.
