# GrantTap Cursor plugin

GrantTap connects Cursor to the GrantTap phone app through a loopback-only HTTP
MCP server. Cursor can show its native **Authorize** action, while GrantTap keeps
each phone response tied to the exact originating chat and prompt.

## Connect Cursor

Install the supported CLI, then run the onboarding commands in this order:

```bash
npm install -g granttap-mcp
granttap setup
granttap connect
granttap setup
granttap status
```

The commands have separate jobs:

1. `granttap setup` detects Cursor, installs and verifies the persistent loopback OAuth/MCP
   service, then writes only GrantTap's entry in `~/.cursor/mcp.json`.
2. `granttap connect` displays a one-time QR and a short manual code for pairing
   the iPhone or iPad app. If Cursor's consent page already completed pairing,
   this command is not needed again.
3. `granttap setup` installs the Cursor, Claude Code, and Codex policy hooks and
   the background task-sync helper. OAuth remains a separate authorization.
4. `granttap status` performs a read-only readiness check.

After `granttap setup`, open **Cursor Settings → MCP → GrantTap** and choose
**Authorize**. The local consent page confirms access to this Mac's GrantTap
pairing. If the Mac is not paired, it offers the same one-time QR and manual-code
fallback as the CLI.

The OAuth service listens only at `http://127.0.0.1:17342/mcp`. Cursor cannot
show **Authorize** for a stdio (`command`/`args`) MCP entry, so do not replace the
plugin's HTTP configuration with stdio.

## Install these local plugin assets

Until the plugin is published in a Cursor marketplace, link this directory from
a source checkout and reload Cursor:

```bash
mkdir -p "$HOME/.cursor/plugins/local"
ln -sfn "$PWD/cursor-plugin" "$HOME/.cursor/plugins/local/granttap"
```

Run those commands from the repository root. The plugin adds the `/connect`
command, a connect skill, and the exact-correlation rule; `granttap setup`
still configures the MCP endpoint itself.

## Exact dual-channel behavior

For an interactive question or approval, Cursor and the phone receive the same
complete prompt under one correlation identity. The first answer carrying that
exact correlation wins. A response from another chat, agent task, or older
prompt must never resolve the current request.

## Included files

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Cursor plugin manifest |
| `.cursor-plugin/marketplace.json` | Marketplace metadata for future publication |
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
