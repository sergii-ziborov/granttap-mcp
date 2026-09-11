---
name: granttap-connect
description: Connect, reconnect, or pair this computer with GrantTap. Use when the user asks to install GrantTap, connect an agent, check the pairing, or show a GrantTap QR.
---

# Connect GrantTap

Call the GrantTap MCP `connect` tool immediately for pairing, connection-status,
or QR requests. It reuses the existing secure machine pairing. When no pairing
exists, it returns an interactive connection card with a one-time QR image and
a manual fallback for the user to open in GrantTap on iPhone.

Show the returned QR image directly in the conversation. Do not expose, repeat,
log, or summarize the pairing URI or manual token in additional prose.

Do not reset or replace a healthy pairing just to display a QR. If `connect`
reports that the pairing was reused, explain that no new QR is needed.

For reconnect requests, obtain the user's explicit confirmation that replacing
the current pairing is intended, then call `reconnect` with `confirmed: true`.
Never infer that confirmation from an unrelated connect or status request.

Plugin installation registers the MCP server for this agent. If the user also
wants provider hooks or the background helper repaired, tell them to run
`npx -y granttap-mcp@0.8.8 setup` locally. Provider authentication remains
separate from GrantTap pairing.
