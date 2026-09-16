---
description: Authorize Cursor and connect or reconnect the GrantTap phone app
---

Use the `granttap-connect` skill in `skills/connect/SKILL.md` and follow it
end-to-end.

1. On this computer, run `granttap setup`. It installs hooks and removes any
   leftover user GrantTap entry from `~/.cursor/mcp.json`.
2. Pair and change settings in the GrantTap plugin connection card and the
   GrantTap app. Do not add GrantTap in Cursor Customize → MCPs.
3. Keep the plugin's stdio MCP entry. Do not point Cloud at
   `http://127.0.0.1:17342/mcp`.
4. Run `granttap status` on the user's computer, then verify the GrantTap MCP
   tools respond in Cursor.
5. For a test question, send the same complete prompt to Cursor and GrantTap
   under one exact correlation. Accept only the first answer correlated to that
   prompt; never reuse a response from another chat or request.

Do not write GrantTap into `~/.cursor/mcp.json`. Cloud cannot reach localhost.
