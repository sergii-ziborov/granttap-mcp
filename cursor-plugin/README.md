# GrantTap Cursor plugin

GrantTap connects Cursor to the GrantTap phone app through a loopback-only HTTP
MCP server. Cursor can show its native **Authenticate** action, while GrantTap keeps
each phone response tied to the exact originating chat and prompt.

## Connect Cursor

Install the supported CLI and the GrantTap plugin from Cursor's marketplace,
then run:

```bash
npm install -g granttap-mcp
granttap setup
granttap status
```

The commands have separate jobs:

1. `granttap setup` detects Cursor, installs and verifies the persistent loopback OAuth/MCP
   service, then writes only GrantTap's entry in `~/.cursor/mcp.json`.
2. `granttap setup` also installs the supported policy hooks and background
   task-sync helper. OAuth remains a separate authorization.
3. `granttap status` performs a read-only readiness check.

After `granttap setup`, open **Cursor Customize → MCPs → GrantTap** and choose
**Authenticate**. The browser opens granttap.com/connect to authorize Cursor.
If this computer is not paired, the website shows a one-time QR and manual-code
fallback; a saved pairing is reused unless you explicitly confirm reconnect.

On Windows, `granttap setup` registers the loopback MCP and phone monitor as
least-privileged jobs under your signed-in account. Install Node.js 20+ and the
current `granttap-mcp` package on that same Windows computer; the plugin alone
cannot start the local server. The jobs restart after a crash and keep running
when Cursor closes. Run `granttap status` to confirm readiness before choosing
**Authenticate** in Cursor.

The OAuth service listens only at `http://127.0.0.1:17342/mcp`. Cursor cannot
show **Authenticate** for a stdio (`command`/`args`) MCP entry, so do not replace the
plugin's HTTP configuration with stdio.

## Install from the Cursor marketplace

Install **GrantTap** from Cursor's plugin marketplace, then reload Cursor.
The plugin adds the `/connect` command, a connect skill, and the
exact-correlation rule; `granttap setup` still configures the MCP endpoint
itself.

## Exact dual-channel behavior

For an interactive question or approval, Cursor and the phone receive the same
complete prompt under one correlation identity. The first answer carrying that
exact correlation wins. A response from another chat, agent task, or older
prompt must never resolve the current request.

## Included files

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Cursor plugin manifest |
| `.cursor-plugin/marketplace.json` | Plugin-local marketplace metadata |
| `../.cursor-plugin/marketplace.json` | Repository marketplace index Cursor publishes |
| `mcp.json` | Loopback Streamable HTTP MCP endpoint |
| `assets/logo.svg` | Plugin logo |
| `rules/dual-channel.mdc` | Exact prompt/correlation rule |
| `skills/connect/SKILL.md` | Authorization and pairing workflow |
| `commands/connect.md` | `/connect` command |

Troubleshooting details live in
[`docs/cursor-authorize.md`](../docs/cursor-authorize.md).

## License

The plugin is distributed under the GrantTap Commercial Source License included
in this directory. Production use requires Authorized Access to GrantTap.
