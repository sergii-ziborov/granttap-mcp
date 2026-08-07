---
name: granttap-connect
description: Connect or reconnect GrantTap phone dual-channel approvals in Cursor via HTTP MCP (connect, setup, notify). Use when the user says connect GrantTap, reconnect, pair phone, show QR, Authorize, or MCP is missing.
---

# GrantTap connect / reconnect

Pair this Cursor session with the GrantTap iPhone (and Watch) so approvals and questions work on **both** Cursor chat and the phone.

## Goals

1. Ensure the GrantTap **HTTP** MCP server is available (Authorize requires HTTP, not stdio).
2. Run connect (QR / pairing) and setup (hooks / helpers / local plugin sync) as needed.
3. Confirm dual-channel: every interactive prompt goes to chat **and** phone with identical text.
4. Prefer the stable JS MCP (`granttap-mcp`). A Rust MCP may come later; do not require it.
5. Never gut the phone app or strip in-chat product UI to “fix” pairing.

## When to use

- User says “Connect GrantTap”, “reconnect”, “pair phone”, “Authorize”, or “show QR”.
- MCP tools `ask` / `ask_yes_no` / `notify` / `connect` / `setup` are missing or failing.
- The Local GrantTap plugin stub has no description / no Authorize button (stdio-only local folder).
- Approvals never appear on the phone, or the monitor/session path looks dead after install.

## Steps

### 1. Confirm HTTP MCP (Authorize)

Cursor’s **Authorize** button only appears for HTTP MCP. Plugin `mcp.json` must be:

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

Keep the local HTTP listener alive:

```bash
granttap-mcp serve
# or: npx -y granttap-mcp@latest serve
```

`granttap-mcp setup` installs a LaunchAgent (`com.granttap.mcp-http`) for this, syncs the local Cursor plugin, and points `~/.cursor/mcp.json` at the HTTP URL.

If MCP is not loaded, tell the user to reload the window after setup, then retry. Do **not** fall back to stdio in the plugin `mcp.json` — that hides Authorize.

### 2. Connect (pairing)

Call the GrantTap MCP `connect` tool.

- Surface the one-time QR / pairing payload **in Cursor chat** so the user can scan from the phone.
- Keep the decision text identical if any confirmation is required on both channels.
- If the MCP client cannot render QR, fall back to CLI:

```bash
npx -y granttap-mcp@latest connect
```

Use the CLI path only as a fallback for clients that cannot show the QR from MCP. Do not run bare `npx -y granttap-mcp@latest` without the `connect` subcommand.

### 3. Setup (hooks / helper / HTTP / plugin)

If hooks, the macOS helpers, Cursor HTTP MCP config, or the local plugin are missing, call MCP `setup`. CLI fallback:

```bash
npx -y granttap-mcp@latest setup
```

Do not run bare `npx -y granttap-mcp@latest` without the `setup` subcommand.

Do **not** manually stack a second `ask_yes_no` for the same shell gate when the Cursor `beforeShellExecution` hook is already installed — MCP joins the open hook decision.

### 4. Notify and verify

Use non-blocking `notify` for status (“paired”, “hooks installed”). Do not turn ordinary status into an approval gate.

Before declaring success:

- Plugin shows description + **Authorize** (HTTP MCP).
- MCP tools respond.
- A test `notify` or harmless dual-channel question reaches the phone.
- Interactive text in chat matches the phone card exactly; either channel’s answer is enough.

## Dual-channel (non-negotiable)

- Every interactive question/approval → Cursor chat **and** GrantTap phone.
- Identical complete decision sentence in both channels.
- First valid answer wins; never require both.
- Prefer `notify` for informational updates.

## Do not

- Put stdio (`command`/`args`) in plugin `mcp.json` — Authorize will not appear.
- Strip phone in-chat UI, skills, MCP toggles, or approvals to work around hangs (see `no-feature-strip`).
- Spawn many parallel agents for the same connect/phone fix (see `anti-thrash`).
- Use `required_permissions: ["all"]` for routine shell work when a hook-gated sandbox path exists.
- Depend on a future Rust MCP; ship and verify with the JS package.

## Related

- Rules: `dual-channel`, `anti-thrash`, `no-feature-strip`
- Slash command: `/connect`
- Docs: [`docs/cursor-authorize.md`](../../../docs/cursor-authorize.md)
- Package: [`granttap-mcp`](https://www.npmjs.com/package/granttap-mcp)
