# Cursor Authorize for GrantTap

## Evidence (how Lovable does it)

Installed Lovable plugin MCP config:

`~/.cursor/plugins/cache/cursor-public/lovable/.../mcp.json`

```json
{
  "mcpServers": {
    "lovable": {
      "type": "http",
      "url": "https://mcp.lovable.dev",
      "auth": {
        "CLIENT_ID": "6d465f583e1e4ce5801b1616f735670c"
      }
    }
  }
}
```

Live probe of `https://mcp.lovable.dev`:

- Unauthenticated MCP `initialize` → HTTP **401**
- `WWW-Authenticate: Bearer realm="mcp", resource_metadata="https://mcp.lovable.dev/.well-known/oauth-protected-resource"`
- Protected resource metadata points at `authorization_servers: ["https://lovable.dev/oauth"]`

Figma is the same shape (`https://mcp.figma.com/mcp` + OAuth PRM).

## What Cursor requires

From [Cursor MCP docs](https://cursor.com/docs/mcp):

| Transport | Auth |
| --- | --- |
| stdio | Manual |
| SSE / Streamable HTTP | OAuth |

Static OAuth client credentials (`auth.CLIENT_ID`) are optional when the server
supports Dynamic Client Registration. GrantTap’s local AS exposes `/register`.

## GrantTap implementation

`granttap serve` starts a **loopback-only** Streamable HTTP MCP server with
an embedded OAuth AS:

- Resource: `http://127.0.0.1:17342/mcp`
- PRM: `/.well-known/oauth-protected-resource/mcp`
- AS metadata: `/.well-known/oauth-authorization-server`
- Consent: `/authorize` → HTML → `/consent` (Approve links Cursor to local pair)
- Tokens: `~/.granttap/mcp-oauth.json`

Authorize **means** “Cursor may call GrantTap tools on this Mac.” Phone pairing
remains the E2EE model in `~/.granttap/machine.json`.

The supported entry point is `granttap authorize`. It installs
`~/Library/LaunchAgents/com.granttap.mcp-http.plist` with an absolute safe Node
and installed GrantTap launcher, RunAtLoad, and KeepAlive. It verifies the exact
GrantTap health schema before atomically changing `~/.cursor/mcp.json`, then
exits; the service survives terminal closure and login/reboot. `granttap serve`
is the foreground troubleshooting command.

`granttap setup` separately installs Cursor's shell/MCP policy hooks. It never
starts a new OAuth enrollment, but repairs the persistent service when the exact
HTTP GrantTap entry is already configured. `granttap status` probes `/healthz`;
a configured but unreachable endpoint is reported as action required.
