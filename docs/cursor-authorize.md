# Cursor Beta setup

The normal path is one command:

```bash
granttap setup
```

When Cursor is installed, setup installs GrantTap shell and MCP policy hooks
and removes any leftover user GrantTap entry from `~/.cursor/mcp.json`. Pair
and change settings in the GrantTap plugin and the GrantTap app. Do not add
GrantTap in Cursor Customize → MCPs.

Cursor Cloud Agents cannot reach `http://127.0.0.1`. A user HTTP MCP entry
there is why Cloud shows **Error · fetch failed**. The Marketplace plugin
uses stdio (`node -e` so cwd `$HOME` still starts GrantTap; on Windows that
bootstrap runs `cmd.exe /c npx`).
Authorize in the browser on `granttap.com/connect`; that page talks only to
the website, not to loopback. Pairing stays on the connection card, last
resort a QR there.

If the Cursor integration later needs repair, run:

```bash
granttap cursor repair
```

That repairs the local helper and again removes a user GrantTap MCP entry.
It does not write GrantTap back into `mcp.json`.
