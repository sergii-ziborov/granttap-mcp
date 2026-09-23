# GrantTap Cursor plugin

GrantTap connects Cursor to the GrantTap phone app. The Marketplace plugin
ships stdio MCP. Pair and change settings in the plugin connection card and
the GrantTap app. Do not add GrantTap in Cursor Customize → MCPs. GrantTap
keeps each phone response tied to the exact originating chat and prompt.

## Connect Cursor

Install the supported CLI on this computer, then run:

```bash
npm install -g granttap-mcp@0.8.20
granttap setup
granttap status
```

The commands have separate jobs:

1. `granttap setup` detects Cursor, installs policy hooks, and removes any
   leftover user GrantTap entry from `~/.cursor/mcp.json`.
2. `granttap setup` also installs the background task-sync helper.
3. `granttap status` performs a read-only readiness check.

After `granttap setup`, pair on `granttap.com/connect` — Approve this coding
app, Reconnect, or Add another. A saved pairing still opens that page. Scan
in the GrantTap app only when a new device joins. Cloud **Error · fetch
failed** is a leftover HTTP MCP at `http://127.0.0.1:17342/mcp` — either a
user Customize → MCPs row or an old plugin `mcp.json`. The current plugin is
stdio (`node -e`) so Cloud never fetches loopback.

On Windows, `granttap setup` registers the local helper and phone monitor as
least-privileged jobs under your signed-in account. Install Node.js 20+ and the
current `granttap-mcp` package on that same Windows computer. The jobs restart
after a crash and keep running when Cursor closes.

The plugin `mcp.json` starts GrantTap with `node -e` so Cursor's cwd=`$HOME`
does not have to contain `stdio-bootstrap.js`. On Windows it runs npm's
JavaScript entry point through Node, avoiding command-shell quoting. Do not add a GrantTap URL to
`~/.cursor/mcp.json`.

## Install the Cursor plugin

The plugin source is public and MIT-licensed at
`sergii-ziborov/granttap-mcp`. Cursor Marketplace listings require Cursor's
review; a Git import does not automatically receive marketplace updates. Install
the reviewed **GrantTap** listing when it is available to your account, or
import the public repository once and reload Cursor. The plugin adds `/connect`, a connect
skill, and the exact-correlation rule; `granttap setup` configures the local
MCP endpoint separately.

Pushing this repository updates the plugin source. Cursor reviews marketplace
updates separately, so confirm the displayed version after review. Keep `name`
as `granttap` and the GitHub URL as `sergii-ziborov/granttap-mcp`; do not create
a second listing. The only Cursor marketplace file is the repo-root
`.cursor-plugin/marketplace.json`, and it lists this plugin once.

If Customize or Marketplace shows both a lowercase **granttap** cube and an
orange **GrantTap** card, uninstall or unpublish the cube. Keep the single
**GrantTap** entry with the orange check-and-wave icon. On the same computer,
rerun `granttap setup` and `granttap status` so the MCP service and hooks point
to the permanent npm install instead of an old temporary path. A workspace-scoped
import is not needed when the user-scoped plugin is already installed.

## Exact dual-channel behavior

For an interactive question or approval, Cursor and the phone receive the same
complete prompt under one correlation identity. The first answer carrying that
exact correlation wins. A response from another chat, agent task, or older
prompt must never resolve the current request.

## Included files

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Cursor plugin manifest |
| `mcp.json` | Plugin stdio MCP (`node -e`, cwd-independent). Do not add GrantTap to user `mcp.json`. |
| `stdio-bootstrap.cjs` | Readable bootstrap used by tests and the inline MCP command. |
| `assets/logo.svg` | Plugin logo |
| `rules/dual-channel.mdc` | Exact prompt/correlation rule |
| `skills/connect/SKILL.md` | Authorization and pairing workflow |
| `commands/connect.md` | `/connect` command |

Troubleshooting details live in
[`docs/cursor-authorize.md`](../docs/cursor-authorize.md).

## License

The plugin is distributed under the [MIT License](LICENSE). The GrantTap iPhone
and Apple Watch app and hosted service have separate terms.
