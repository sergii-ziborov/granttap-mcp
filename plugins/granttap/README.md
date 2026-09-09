# GrantTap for Codex, Claude Code, and Grok Build

![GrantTap](assets/logo.png)

GrantTap pairs local coding agents with one encrypted machine connection so you
can approve requests, answer questions, inspect work, and steer tasks from
iPhone and Apple Watch.

## Install from the GrantTap marketplace

### Codex

```bash
codex plugin marketplace add sergii-ziborov/granttap-mcp
codex plugin add granttap@granttap
```

Open GrantTap from the plugin page or ask Codex: `Show my GrantTap pairing QR.`
Codex shows an interactive connection card with Connect, Reconnect, status,
and the one-time QR when pairing is needed.

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

- `connect` pairs the computer or reuses its current pairing.
- `reconnect` creates a fresh pairing only after explicit confirmation.
- `notify` sends a task update to GrantTap.
- `ask_yes_no` asks for an explicit yes or no decision.
- `ask` asks for typed or spoken input.

The plugin runs the pinned public package `granttap-mcp@0.8.7`. See
[granttap.com](https://granttap.com) for the iPhone and Apple Watch app,
privacy policy, and terms.

Use of GrantTap is governed by the
[GrantTap Commercial Source License](LICENSE).
