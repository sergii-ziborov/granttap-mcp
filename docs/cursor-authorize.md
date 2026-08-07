# Cursor Authorize for GrantTap

Cursor’s Plugins UI **Authorize** control appears for **HTTP** MCP servers. It does **not** appear for stdio MCP (`command` + `args`).

## Symptom

`~/.cursor/plugins/local/granttap` contains only `.git` (or a stdio `mcp.json`). Settings → Plugins → Local shows an empty **Granttap** stub: no description, no **Authorize**.

## Fix

1. Use the `cursor-plugin/` package from this repo (manifest, logo, rules, skills, HTTP `mcp.json`).
2. Keep a loopback Streamable HTTP listener running:

   ```bash
   granttap-mcp serve
   ```

   Default URL: `http://127.0.0.1:17342/mcp`.

3. Point Cursor at that URL (plugin `mcp.json` and/or `~/.cursor/mcp.json`):

   ```json
   {
     "mcpServers": {
       "granttap": {
         "type": "http",
         "url": "http://127.0.0.1:17342/mcp"
       }
     }
   }
   ```

4. Or run one-shot setup from the repo / npm package:

   ```bash
   granttap-mcp setup
   ```

   Setup installs LaunchAgent `com.granttap.mcp-http` (`granttap-mcp serve`, KeepAlive), syncs `cursor-plugin/` → `~/.cursor/plugins/local/granttap`, and rewrites `~/.cursor/mcp.json` (backup once as `.bak-granttap`).

5. Reload the Cursor window. Open Local → **GrantTap** and use **Authorize**.

## Do not

- Ship stdio in the Cursor plugin `mcp.json` if you need Authorize.
- Expect Authorize from a Local folder that only has a git checkout without the plugin package files.
