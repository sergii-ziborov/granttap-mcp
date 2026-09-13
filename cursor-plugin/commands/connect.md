---
description: Authorize Cursor and connect or reconnect the GrantTap phone app
---

Use the `granttap-connect` skill in `skills/connect/SKILL.md` and follow it
end-to-end.

1. Run `granttap setup` to detect Cursor and configure the persistent loopback HTTP
   MCP/OAuth service.
2. Open **Cursor Customize → MCPs → GrantTap → Authenticate**. Complete
   authorization and any one-time QR pairing on `https://granttap.com/connect`.
3. Run `granttap status`, then verify the GrantTap MCP tools respond in Cursor.
5. For a test question, send the same complete prompt to Cursor and GrantTap
   under one exact correlation. Accept only the first answer correlated to that
   prompt; never reuse a response from another chat or request.

Do not replace the plugin's HTTP MCP entry with stdio: Cursor exposes
**Authenticate** only for HTTP/SSE MCP transports.
