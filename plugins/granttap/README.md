# GrantTap for Codex, Claude Code, Cursor, and Grok Build

![GrantTap](assets/logo.png)

GrantTap pairs local coding agents with one encrypted machine connection so you
can approve requests, answer questions, inspect work, and steer tasks from
iPhone and Apple Watch.

## Install from the GrantTap marketplace

### Codex

Install the durable local GrantTap helper on each Mac or Windows computer you connect:

```bash
npm install --global granttap-mcp@0.8.24
granttap setup
```

Install or update the plugin from the public GitHub marketplace:

```bash
codex plugin marketplace add sergii-ziborov/granttap-mcp
codex plugin add granttap@granttap
```

Codex **Connected accounts** lists external app accounts, not GrantTap phones.
GrantTap has no separate account sign-in. On the plugin page, click **Try now →
Connect GrantTap to this computer** to open its connection card in a conversation.
On a new computer, the card shows **Add a device** and a one-time QR. In the
GrantTap iPhone app, open **Settings → Connections → Add a device (Scan QR)**
and scan it. For another iPhone or iPad, choose **Add another device** in the
card; for the same phone after reinstall, choose **Reconnect**. A saved
computer pairing does not automatically put a phone in Codex's account list.
If a coding app cannot operate the card, run `granttap phone add` in your own
interactive terminal, or `granttap phone reconnect` for the same phone. These
commands refuse to print a private QR into redirected output or agent logs.

`codex mcp login granttap` authorizes Codex as an MCP client. Its browser page
at `granttap.com/connect` shows the approval request and phone observations;
the connection card shows the pairing QR. The website does not receive pairing
keys or task content. Provider sign-in remains separate. Never paste a pairing
token or QR into chat. A Git marketplace plugin does not acquire the native
Connect modal of a registered remote OpenAI app merely by installing it.

After one iPhone is linked, its GrantTap Settings can show an expiring QR to
add another iPhone or iPad as a controller of the same Live computers. That
device pairing is separate from inviting a person into Project Mesh. Offline
computers are listed as omitted and need a fresh QR when they reconnect.

The `connection_status` tool opens GrantTap's connection panel in the
conversation. It shows connection
status, relay and phone observations, provider readiness, Connect, Refresh
status, and confirmed Reconnect controls.

### Claude Code

Install the same local helper first, then install the plugin:

```bash
npm install --global granttap-mcp@0.8.24
granttap setup
claude plugin marketplace add sergii-ziborov/granttap-mcp
claude plugin install granttap@granttap
```

Open `/mcp`, select GrantTap and authenticate. The browser uses the same
`granttap.com/connect` flow. Then run `/granttap:granttap-connect` or ask
Claude for connection status.

### Cursor

After installing the helper, pair on `granttap.com/connect` and in the
GrantTap app. Do not add GrantTap in Cursor Customize → MCPs. Cloud **Error
· fetch failed** is leftover HTTP at `http://127.0.0.1:17342/mcp` — a user
MCP row or an old plugin `mcp.json`. The Cursor plugin is stdio (`node -e`).
Cloud Agents start that process. They cannot fetch `http://127.0.0.1`.

### Grok Build

```bash
npm install --global granttap-mcp@0.8.24
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

The plugin and local MCP runtime are distributed under the [MIT License](LICENSE).
The GrantTap iPhone and Apple Watch app and hosted service have separate terms.
