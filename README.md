# GrantTap MCP

[![npm](https://img.shields.io/npm/v/granttap-mcp)](https://www.npmjs.com/package/granttap-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The public, auditable machine-side bridge for [GrantTap](https://granttap.com):
ask a person, send a status update, or request an approval on their iPhone or
Apple Watch without sending agent traffic through a model proxy.

GrantTap MCP complements the agents' native permission hooks:

- MCP is the voluntary channel: the agent calls `ask`, `ask_yes_no`, or `notify`.
- Hooks are the mandatory approval channel: Claude Code or Codex pauses before
  a tool call and waits for Allow or Deny.
- Both channels use the same end-to-end encrypted GrantTap pairing.

| Visible iPhone activity | Approval on Apple Watch |
| --- | --- |
| ![GrantTap activity on iPhone](docs/images/phone-activity.png) | ![GrantTap approval on Apple Watch](docs/images/watch-approval.png) |

The iPhone and Apple Watch app is preparing for App Store release. Current
status and target date are published at [granttap.com](https://granttap.com).

## Install

The shortest MCP-only setup is:

```bash
codex mcp add granttap -- npx -y granttap-mcp
claude mcp add granttap -- npx -y granttap-mcp
```

Pair this computer with the GrantTap app, then register the approval hooks:

```bash
npm install -g granttap-mcp
granttap-mcp connect
granttap-mcp setup
```

`connect` prints a QR and an optional one-time eight-character code. It uses
the production zero-knowledge relay by default; pass your own `wss://` URL as
the first argument to self-host. The pairing lives locally in
`~/.granttap/machine.json`; this package never uploads the device secret key.
Existing beta installations using `~/.nodvox/` are migrated automatically.

`connect` also registers both hooks. `setup` is an idempotent standalone
command for upgrades: it preserves unrelated settings and writes a backup
before changing a configuration file.

## MCP tools

| Tool | Result |
| --- | --- |
| `ask` | Sends an open question and waits for a spoken or typed reply |
| `ask_yes_no` | Sends a yes/no question and waits for a tap |
| `notify` | Sends a non-blocking status message |
| `setup` | Registers the Claude Code and Codex approval hooks |

## CLI commands

| Command | Purpose |
| --- | --- |
| *(no command)* | Starts the GrantTap MCP stdio server |
| `connect [relayUrl]` | Creates an E2EE pairing and prints a QR/short code |
| `setup` | Registers the Claude Code and Codex approval hooks |

The default answer timeout is three minutes. Override it with
`GRANTTAP_ASK_TIMEOUT_MS`.

## Security model

Message payloads are authenticated and encrypted locally with NaCl
public-key boxes. The relay receives only routing metadata and opaque
ciphertext. It has no device secret key and cannot decrypt questions,
commands, replies, or approvals.

This repository intentionally includes the protocol, crypto client, relay
client, MCP server, and agent hook adapters so that the complete public
machine-side trust boundary can be reviewed.

The relay still observes metadata such as room identifiers, IP addresses,
timing, and message sizes. Review or self-host the public
[GrantTap relay](https://github.com/sergii-ziborov/granttap-relay) if that
metadata matters to your deployment.

## Development

Requires Node.js 20 or newer.

```bash
git clone https://github.com/sergii-ziborov/granttap-mcp.git
cd granttap-mcp
npm install
npm test
npm run typecheck
```

Start the stdio server with `npm start`. Run `npm run setup` only on a machine
where you want the hooks installed; existing config files are backed up once
as `*.bak-granttap`.

## Related

- Product: [granttap.com](https://granttap.com)
- npm: [granttap-mcp](https://www.npmjs.com/package/granttap-mcp)
- Relay: [sergii-ziborov/granttap-relay](https://github.com/sergii-ziborov/granttap-relay)
- Privacy: [granttap.com/privacy](https://granttap.com/privacy)
- Support: [granttap.com/support](https://granttap.com/support)

GrantTap is not affiliated with Anthropic or OpenAI.
