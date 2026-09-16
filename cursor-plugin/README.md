# GrantTap Cursor plugin

GrantTap connects Cursor to the GrantTap phone app. The Marketplace plugin
ships stdio MCP. Pair and change settings in the plugin connection card and
the GrantTap app. Do not add GrantTap in Cursor Customize → MCPs. GrantTap
keeps each phone response tied to the exact originating chat and prompt.

## Connect Cursor

Install the supported CLI on this computer, then run:

```bash
npm install -g granttap-mcp
granttap setup
granttap status
```

The commands have separate jobs:

1. `granttap setup` detects Cursor, installs policy hooks, and removes any
   leftover user GrantTap entry from `~/.cursor/mcp.json`.
2. `granttap setup` also installs the background task-sync helper.
3. `granttap status` performs a read-only readiness check.

After `granttap setup`, pair in the GrantTap plugin and the GrantTap app.
A leftover user HTTP entry at `http://127.0.0.1:17342/mcp` is why Cloud shows
fetch failed.

On Windows, `granttap setup` registers the local helper and phone monitor as
least-privileged jobs under your signed-in account. Install Node.js 20+ and the
current `granttap-mcp` package on that same Windows computer. The jobs restart
after a crash and keep running when Cursor closes.

The plugin `mcp.json` starts `node stdio-bootstrap.js`. On Windows that bootstrap
runs `cmd.exe /c npx` so Cursor can spawn the MCP. Do not add a GrantTap URL to
`~/.cursor/mcp.json`.

## Install the Cursor plugin

The plugin source is public and MIT-licensed at
`sergii-ziborov/granttap-mcp`. Cursor Marketplace listings require Cursor's
review; a Git import does not automatically receive marketplace updates. Install
the reviewed **GrantTap** listing when it is available to your account, or
import the public repository once and reload Cursor. The plugin adds `/connect`, a connect
skill, and the exact-correlation rule; `granttap setup` configures the local
MCP endpoint separately.

If Customize shows both a lowercase **granttap** entry with a generic cube and
an older green **GrantTap** entry, those are saved imports from earlier versions.
Remove both old imports in Cursor, then install one public listing or import
`sergii-ziborov/granttap-mcp` once at the user scope and reload. Keep the single **GrantTap** entry with the
orange check-and-wave icon. On the same computer, rerun `granttap setup` and
`granttap status` so the MCP service and hooks point to the permanent npm install
instead of an old temporary path. A workspace-scoped import is not needed when
the user-scoped plugin is already installed.

## Exact dual-channel behavior

For an interactive question or approval, Cursor and the phone receive the same
complete prompt under one correlation identity. The first answer carrying that
exact correlation wins. A response from another chat, agent task, or older
prompt must never resolve the current request.

## Included files

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Cursor plugin manifest |
| `../.cursor-plugin/marketplace.json` | Repository marketplace index Cursor publishes |
| `mcp.json` | Plugin stdio MCP (`node stdio-bootstrap.js`). Do not add GrantTap to user `mcp.json`. |
| `stdio-bootstrap.js` | Starts `granttap-mcp` via `node` on every OS, and via `cmd /c npx` on Windows. |
| `assets/logo.svg` | Plugin logo |
| `rules/dual-channel.mdc` | Exact prompt/correlation rule |
| `skills/connect/SKILL.md` | Authorization and pairing workflow |
| `commands/connect.md` | `/connect` command |

Troubleshooting details live in
[`docs/cursor-authorize.md`](../docs/cursor-authorize.md).

## License

The plugin is distributed under the [MIT License](LICENSE). The GrantTap iPhone
and Apple Watch app and hosted service have separate terms.
