# GrantTap for Codex, Claude Code, Cursor, and Grok Build

![GrantTap](assets/logo.png)

GrantTap pairs local coding agents with one encrypted machine connection so you
can approve requests, answer questions, inspect work, and steer tasks from
iPhone and Apple Watch.

## Install from the GrantTap marketplace

### Codex

Install the durable local GrantTap helper on each Mac or Windows computer you connect:

```bash
npm install --global granttap-mcp@0.8.16
granttap setup
```

Install or update the plugin from the public GitHub marketplace:

```bash
codex plugin marketplace add sergii-ziborov/granttap-mcp
codex plugin add granttap@granttap
```

Run `codex mcp login granttap` or use Codex's MCP authorization control.
The browser opens `granttap.com/connect`. If this computer is not yet paired,
the site shows a one-time QR for the GrantTap iPhone app. If it is already
paired, approving this coding app preserves the phone keys; a separate,
confirmed reconnect replaces the pairing and shows a new QR. The website
does not receive the pairing keys or task content. Provider sign-in remains
separate. A Git marketplace plugin does not acquire the native Connect modal
of a registered remote OpenAI app merely by installing it.

In Codex, click **Try now** on the GrantTap plugin page and choose **Connect
GrantTap to this computer**. After authorization, the `connection_status` tool
opens GrantTap's connection panel in the conversation. It shows connection
status, relay and phone observations, provider readiness, Connect, Refresh
status, and confirmed Reconnect controls.

### Claude Code

Install the same local helper first, then install the plugin:

```bash
npm install --global granttap-mcp@0.8.16
granttap setup
claude plugin marketplace add sergii-ziborov/granttap-mcp
claude plugin install granttap@granttap
```

Open `/mcp`, select GrantTap and authenticate. The browser uses the same
`granttap.com/connect` flow. Then run `/granttap:granttap-connect` or ask
Claude for connection status.

### Cursor

After installing the helper, open **Cursor Customize → MCPs → GrantTap →
Authenticate**. Cursor uses the same website flow.

### Grok Build

```bash
npm install --global granttap-mcp@0.8.16
granttap setup
grok plugin marketplace add sergii-ziborov/granttap-mcp
grok plugin install granttap --trust
```

Open `/mcps` and authenticate GrantTap, then run `/granttap-connect` or ask
Grok for connection status.

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

Codex, Claude Code, Cursor, and Grok Build use the persistent local HTTP
service installed by `granttap setup`. See
[granttap.com](https://granttap.com) for the iPhone and Apple Watch app,
privacy policy, and terms.

Use of GrantTap is governed by the
[GrantTap Commercial Source License](LICENSE).
