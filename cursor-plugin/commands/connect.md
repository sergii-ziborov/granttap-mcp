---
description: Authorize Cursor and connect or reconnect the GrantTap phone app
---

Use the `granttap-connect` skill in `skills/connect/SKILL.md` and follow it
end-to-end.

1. Run `granttap authorize` to configure and verify the persistent loopback HTTP
   MCP/OAuth service.
2. Open **Cursor Settings → MCP → GrantTap → Authorize**.
3. Run `granttap connect` if pairing is still required; surface its one-time QR
   and manual code to the user.
4. Run `granttap setup`, then verify the result with `granttap status`.
5. For a test question, send the same complete prompt to Cursor and GrantTap
   under one exact correlation. Accept only the first answer correlated to that
   prompt; never reuse a response from another chat or request.

Do not replace the plugin's HTTP MCP entry with stdio: Cursor exposes
**Authorize** only for HTTP/SSE MCP transports.
