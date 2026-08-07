# GrantTap Cursor plugin

Dual-channel approvals for Cursor: phone + chat via GrantTap MCP (`connect`, `ask`, `notify`), agent rules, and a connect/reconnect skill.

**Authorize requires HTTP MCP.** A Local plugin that only has `.git` (or stdio `command`/`args` in `mcp.json`) shows an empty stub with no description and no **Authorize** button. This package ships HTTP MCP pointed at a loopback listener started by `granttap-mcp serve`.

Stable runtime today is the **JS** MCP package: [`granttap-mcp`](https://www.npmjs.com/package/granttap-mcp). A Rust MCP may ship later; prefer JS until then.

## Install in Cursor Plugins

### Recommended: `granttap-mcp setup`

From a clone of this repo (or after `npm install -g granttap-mcp`):

```bash
granttap-mcp setup
```

That command:

1. installs Codex / Claude Code approval hooks and the background monitor LaunchAgent;
2. installs LaunchAgent `com.granttap.mcp-http` running `granttap-mcp serve` (KeepAlive);
3. writes `~/.cursor/mcp.json` with GrantTap as HTTP `http://127.0.0.1:17342/mcp` (backs up once);
4. syncs this `cursor-plugin/` tree into `~/.cursor/plugins/local/granttap`.

Then **Developer: Reload Window** (or restart Cursor). Open **Settings → Plugins → Local → GrantTap** and use **Authorize**.

### Manual local symlink

```bash
# Keep HTTP serve running (or rely on the LaunchAgent from setup)
granttap-mcp serve

ln -sfn <absolute-path-to-cursor-plugin> ~/.cursor/plugins/local/granttap
```

Example if this repo lives at `~/src/granttap-mcp`:

```bash
ln -sfn ~/src/granttap-mcp/cursor-plugin ~/.cursor/plugins/local/granttap
```

### Marketplace (when published)

Install **GrantTap** from the Cursor plugin marketplace once published. Marketplace metadata lives in `.cursor-plugin/marketplace.json`.

### MCP-only fallback (HTTP)

If you only need the MCP server (no plugin rules/skills), add to Cursor MCP settings:

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

Do **not** use stdio (`npx` / `command` + `args`) for the Cursor plugin entry if you need **Authorize**.

Then say **“Connect GrantTap”** or run `/connect` so the agent pairs the phone (QR) and runs `setup` as needed.

## What’s included

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Plugin manifest (`displayName` GrantTap, HTTP `mcpServers`) |
| `.cursor-plugin/marketplace.json` | Marketplace listing metadata |
| `mcp.json` | GrantTap MCP over HTTP at `127.0.0.1:17342/mcp` |
| `assets/logo.svg` | Plugin logo |
| `rules/dual-channel.mdc` | Every interactive prompt → chat **and** phone |
| `rules/anti-thrash.mdc` | Avoid wasted install/debug thrash |
| `rules/no-feature-strip.mdc` | Never gut phone in-chat UI for hangs |
| `skills/connect/SKILL.md` | Connect / reconnect workflow |
| `commands/connect.md` | `/connect` slash command |

## Why HTTP + `granttap-mcp serve`

Cursor shows **Authorize** for HTTP MCP servers (same pattern as Lovable’s remote HTTP MCP). Stdio MCP never gets that button. `granttap-mcp serve` binds Streamable HTTP on loopback port `17342` so the plugin can point at a local URL while tools still run on your Mac.

See also [`docs/cursor-authorize.md`](../docs/cursor-authorize.md).

## Prefer JS MCP; Rust later

Use `granttap-mcp` (Node) as the supported bridge. Do not block installs on a future Rust binary.

## Links

- [granttap.com](https://granttap.com)
- [granttap-mcp on npm](https://www.npmjs.com/package/granttap-mcp)
- [MCP source](https://github.com/sergii-ziborov/granttap-mcp)
