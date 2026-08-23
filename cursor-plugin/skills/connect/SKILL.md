---
name: granttap-connect
description: Authorize Cursor and connect or reconnect GrantTap through loopback HTTP MCP. Use when the user asks to connect, pair, show a QR, reconnect, or repair Cursor Authorize.
---

# GrantTap connect

Connect Cursor to the GrantTap phone app without weakening chat isolation.

## Workflow

### 1. Configure Cursor Authorize

Run:

```bash
granttap setup
```

This installs and verifies the persistent loopback OAuth/MCP service before it
changes GrantTap's entry in `~/.cursor/mcp.json`. Then direct the user to
**Cursor Settings → MCP → GrantTap → Authorize**.

The plugin endpoint must remain HTTP:

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

Do not replace it with a stdio `command`/`args` entry; Cursor does not expose
its native **Authorize** action for stdio MCP servers.

### 2. Pair the phone

If the Mac is not already paired, run:

```bash
granttap connect
```

Show the resulting one-time QR in chat. Preserve the short manual code as a
fallback when the camera or QR rendering is unavailable. The local OAuth
consent page can offer the same pairing choices when Authorize starts first.

### 3. Install policy hooks

Run:

```bash
granttap setup
```

This installs the supported Cursor, Claude Code, and Codex hooks plus the
background task-sync helper. It does not replace the separate OAuth consent.

### 4. Verify

Run the read-only check:

```bash
granttap status
```

Confirm the loopback HTTP service and exact Cursor MCP entry are healthy,
pairing is present, and required hooks are ready. `granttap status` cannot prove
that Cursor retained an OAuth grant, so also confirm the MCP tools respond after
**Authorize**. If Cursor loaded the MCP configuration beforehand, reload the
Cursor window and retry **Authorize**.

For any interactive test, send the same complete prompt to Cursor and GrantTap
under one exact correlation. The first answer carrying that exact correlation
wins. Never use a response from another chat, agent task, prompt, or older
correlation.

## Troubleshooting

- `granttap cursor repair` repairs the OAuth/MCP service when setup cannot;
  normal onboarding should use the persistent `granttap setup` path.
- Run `granttap cursor repair` if `granttap status` reports an unhealthy OAuth
  service.
- Re-run `granttap setup` if the policy hooks or background helper are missing.
- Re-run `granttap connect` only when pairing is absent or must be replaced.
