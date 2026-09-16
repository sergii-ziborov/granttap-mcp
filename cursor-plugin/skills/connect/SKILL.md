---
name: granttap-connect
description: Pair this computer with GrantTap through the plugin connection card and the GrantTap app. Use when the user asks to connect, pair, reconnect, or repair GrantTap.
---

# GrantTap connect

Connect Cursor to the GrantTap phone app without weakening chat isolation.

## Workflow

### 1. Load GrantTap MCP tools

Use the Marketplace plugin. Its MCP entry is stdio:

```json
{
  "mcpServers": {
    "granttap": {
      "command": "node",
      "args": ["stdio-bootstrap.js"]
    }
  }
}
```

On this computer, run:

```bash
granttap setup
```

Setup installs hooks and removes any leftover user GrantTap entry from
`~/.cursor/mcp.json`. Do not add GrantTap in Cursor Customize → MCPs. A user
HTTP entry at `http://127.0.0.1:17342/mcp` is why Cloud shows fetch failed.

### 2. Pair the phone

Call `connection_status` or `connect`. Pairing and settings belong on the
GrantTap connection card and in the GrantTap app. If a QR is needed, it
appears only on that card. Do not print the pairing URI or manual token.
Do not open Cursor Customize to change GrantTap settings.

A saved pairing is reused unless the user confirms reconnect.

### 3. Install policy hooks

`granttap setup` installs the supported Cursor, Claude Code, and Codex hooks
plus the background task-sync helper.

### 4. Verify

On the user's computer, run `granttap status`. Confirm pairing is present and
required hooks are ready. Confirm `connection_status` and `connect` respond.

A Cloud pairing belongs to that Cloud environment; it is not the Mac pairing.

For any interactive test, send the same complete prompt to Cursor and GrantTap
under one exact correlation. The first answer carrying that exact correlation
wins. Never use a response from another chat, agent task, prompt, or older
correlation.

## Troubleshooting

- `granttap cursor repair` removes a leftover user GrantTap MCP entry and
  repairs the local helper.
- Re-run `granttap setup` if the policy hooks or background helper are missing.
- If Cloud login fails with `fetch failed` to `127.0.0.1:17342`, GrantTap is
  still in `~/.cursor/mcp.json`. Remove that user entry, keep the plugin, and
  pair from the connection card.
