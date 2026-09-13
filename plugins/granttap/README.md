# GrantTap for Codex, Claude Code, and Grok Build

![GrantTap](assets/logo.png)

GrantTap pairs local coding agents with one encrypted machine connection so you
can approve requests, answer questions, inspect work, and steer tasks from
iPhone and Apple Watch.

## Install from the GrantTap marketplace

### Codex

Install the durable local OAuth service once on macOS:

```bash
npm install --global granttap-mcp@0.8.10
granttap setup
```

Install or update the plugin from the public GitHub marketplace:

```bash
codex plugin marketplace add sergii-ziborov/granttap-mcp
codex plugin add granttap@granttap
```

Open GrantTap in Codex's plugin manager and select its native Connect/Sign in
control. Codex opens the local OAuth consent page. If the computer is not yet
paired, that page shows a one-time QR for the GrantTap iPhone app. If it is
already paired, Approve authorizes Codex without changing the phone keys; a
separate, confirmed reconnect can replace the pairing and show a new QR. No
GrantTap account or password is needed. Provider sign-in remains separate.

After authorization, ask Codex: `Open my GrantTap connection center.` Its MCP
Apps view shows connection status, relay and phone observations, provider
readiness, Connect, Refresh status, and confirmed Reconnect controls.

### Claude Code

```bash
claude plugin marketplace add sergii-ziborov/granttap-mcp
claude plugin install granttap@granttap
```

Then run `/granttap:granttap-connect` or ask Claude: `Show my GrantTap pairing
QR.`

### Grok Build

```bash
grok plugin marketplace add sergii-ziborov/granttap-mcp
grok plugin install granttap --trust
```

Then run `/granttap-connect` or ask Grok: `Show my GrantTap pairing QR.`

The `connect` tool reuses a healthy pairing. If this computer is not paired, it
returns a one-time QR image and a manual fallback. GrantTap never rotates a
healthy pairing merely to display a new QR.

## Included tools

- `connection_status` opens read-only connection controls and diagnostics.
- `connect` pairs the computer or reuses its current pairing.
- `reconnect` creates a fresh pairing only after explicit confirmation.
- `notify` sends a task update to GrantTap.
- `ask_yes_no` asks for an explicit yes or no decision.
- `ask` asks for typed or spoken input.

Claude Code and Grok Build use the pinned public package `granttap-mcp@0.8.9`
through stdio. Codex uses the persistent local HTTP service installed by
`granttap setup`. See
[granttap.com](https://granttap.com) for the iPhone and Apple Watch app,
privacy policy, and terms.

Use of GrantTap is governed by the
[GrantTap Commercial Source License](LICENSE).
