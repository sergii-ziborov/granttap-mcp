# GrantTap MCP

[![npm](https://img.shields.io/npm/v/granttap-mcp)](https://www.npmjs.com/package/granttap-mcp)
[![CI](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Keep Codex and Claude Code moving from your iPhone or Apple Watch.**

Approve commands, follow active tasks, reply, attach files, start new work, and
run local schedules without exposing agent traffic to the relay. GrantTap MCP is
the open-source machine-side bridge: the agents stay on your Mac, and Cloudflare
only routes authenticated ciphertext it cannot decrypt.

[Website](https://granttap.com) ·
[npm](https://www.npmjs.com/package/granttap-mcp) ·
[Security model](SECURITY.md) ·
[Self-hostable relay](https://github.com/sergii-ziborov/granttap-relay)

<p align="center">
  <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/iphone-command-center.png" alt="GrantTap command center on iPhone showing a Codex approval, an agent question, task search, agent switcher, chat history, and MCP usage" width="330">
  &nbsp;&nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/apple-watch-approval.png" alt="GrantTap Codex approval on Apple Watch" width="230">
</p>

<p align="center"><sub>Current iPhone and Apple Watch UI captured from the app's clearly labelled demo mode — no concept renders.</sub></p>

The companion iPhone and Apple Watch app is currently in testing. Release
status is published at [granttap.com](https://granttap.com).

## What you get

- **Real approvals away from the Mac.** Claude Code or Codex pauses at its
  permission hook; Allow or Deny returns to that same agent flow.
- **One task view for both agents.** See recent Codex and Claude Code tasks,
  human-readable activity, delivery state, usage, and context data the agent
  actually exposes.
- **Continue work from the phone.** Reply to an existing task or create a new
  one for the selected agent and advertised workspace. Send up to five photos,
  camera images, or documents in one message.
- **A useful Watch app, not an approval-only notification.** Browse tasks, open
  recent activity, approve a command, or reply by voice or text.
- **Per-task controls that are enforced locally.** Inspect MCP servers and
  repository skills, disable MCP servers for later GrantTap-delivered turns,
  choose a relevant MCP or skill, and select Codex sandbox access.
- **A local scheduler, not a pretend provider API.** Create recurring Codex or
  Claude Code runs manually or through a conversational planner, then inspect
  the run history from the phone.
- **Receipts instead of optimistic UI.** Messages have stable IDs, encrypted
  accepted/rejected receipts, bounded retries, and queued/sending/delivered/
  failed state.

## See it in action

### iPhone

| Command center | Codex task controls | Observed MCP usage | Claude Code and scheduler |
| --- | --- | --- | --- |
| <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/iphone-command-center.png" alt="GrantTap iPhone command center" width="210"> | <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/iphone-task-detail.png" alt="Codex task context, MCP permissions, and sandbox access in GrantTap" width="210"> | <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/iphone-mcp-usage.png" alt="Observed MCP and skill usage on iPhone" width="210"> | <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/iphone-claude-tasks.png" alt="Claude Code task list and conversational scheduler on iPhone" width="210"> |

The Codex task screen exposes the context window, supported compaction, MCP
allow/deny state, and sandbox access. Claude Code gets its own visual treatment
and planner while keeping its different permission and compaction limits clear.
MCP usage counts only observed calls; context figures are labelled estimates,
not separate MCP billing.

### Apple Watch

| Task inbox | Recent activity and reply | Command approval |
| --- | --- | --- |
| <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/apple-watch-inbox.png" alt="GrantTap task and approval inbox on Apple Watch" width="230"> | <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/apple-watch-task.png" alt="GrantTap task activity with voice and text reply on Apple Watch" width="230"> | <img src="https://raw.githubusercontent.com/sergii-ziborov/granttap-mcp/main/docs/images/apple-watch-approval.png" alt="Codex command approval on Apple Watch" width="230"> |

## Connect in under a minute

Add GrantTap to each agent you use:

```bash
codex mcp add granttap -- npx -y granttap-mcp@latest
claude mcp add granttap -- npx -y granttap-mcp@latest
```

Start a fresh agent task and say **“Connect GrantTap.”** The `connect` tool:

1. creates a new end-to-end encrypted pairing;
2. returns a scannable one-time QR directly in the agent chat;
3. installs the Codex and Claude Code approval hooks; and
4. installs the per-user background helper for task sync and schedules.

Scan the QR with GrantTap on iPhone. No terminal QR, copied pairing JSON, or
open background terminal is required.

If an MCP client cannot render image content, use the CLI fallback:

```bash
npm install -g granttap-mcp
granttap-mcp connect
granttap-mcp setup
```

CLI `connect` prints a one-time QR and short manual code. `setup` is idempotent:
it preserves unrelated agent settings and backs up a configuration file before
changing it. The pairing is stored locally in `~/.granttap/machine.json`.
Existing beta state under `~/.nodvox/` is migrated automatically.

## Codex and Claude Code: honest capability matrix

| Capability | Codex | Claude Code |
| --- | --- | --- |
| Approval hook | `PermissionRequest` when Codex hooks are enabled | `PreToolUse` |
| Resume an existing task | Yes, through the local Codex CLI | Yes, through the local Claude CLI |
| Start a new persistent task | Yes | Yes |
| Up to five attachments | Images through Codex image inputs; documents as local paths | Local image/document paths in the turn |
| Change filesystem access from iPhone | Read-only, workspace, or full for the next GrantTap turn | Not exposed; the existing Claude policy remains authoritative |
| Disable MCP per task | Enforced for later GrantTap-delivered turns | Enforced for later GrantTap-delivered turns |
| Usage and context | Reported when present in local task logs | Reported when present in local task logs |
| Trigger real context compaction | Yes, for an idle task through Codex app-server | No supported remote API; GrantTap reports this honestly |
| Conversational schedule planner | Ephemeral read-only run | Ephemeral plan-mode run |

GrantTap controls local Codex and Claude Code tasks. It does **not** claim to
create ordinary ChatGPT chats, private ChatGPT Scheduled Tasks, Codex
Automations, or Claude Routines through unpublished provider APIs.

Globally disabled MCP servers stay disabled. A phone choice only narrows later
turns sent through GrantTap; it cannot broaden the agent's global configuration.
Repository skills are discovered only in the selected task workspace under
`.agents/skills` or `.claude/skills`.

## MCP tools

| Tool | Result |
| --- | --- |
| `connect` | Creates a pairing and returns a secure one-time QR in chat |
| `ask` | Sends an open question and waits for a spoken or typed reply |
| `ask_yes_no` | Sends a yes/no question and waits for a tap |
| `notify` | Sends a non-blocking status update |
| `setup` | Registers both approval hooks and the terminal-free helper |

The default answer timeout is three minutes. Override it with
`GRANTTAP_ASK_TIMEOUT_MS`.

## Why the relay cannot read a session

- Endpoint keys are generated locally. The relay never receives a device's
  secret encryption key.
- Pairing hand-off uses an opaque mailbox ID plus an independent 256-bit
  transfer key. Only the mailbox ID reaches Cloudflare; the key stays in the QR
  or manual token.
- Every attached Codex or Claude Code task receives its own random 256-bit task
  key. Disclosure of one task key cannot decrypt another task.
- Questions, commands, replies, attachments, approvals, scheduler drafts, and
  task activity remain authenticated ciphertext across the network, relay,
  Durable Objects, and APNs path.
- APNs carries only a content-neutral wake. It contains no title, prompt,
  command, path, task kind, or response.

The relay can still observe operational metadata: opaque room/mailbox IDs, IP
addresses, timing, ciphertext sizes, and APNs device token/environment. A
compromised authorized endpoint can read the tasks explicitly granted to that
endpoint; cryptography cannot hide plaintext from a device authorized to show
it. The exact boundary and threat-model limits are documented in
[SECURITY.md](SECURITY.md).

## Task sync and scheduling

The background helper publishes a bounded window of recent local Codex and
Claude Code task metadata. Older chat metadata is available separately for up
to 90 days and 160 chats; full activity for a task is sent only after the phone
subscribes to it. Hidden reasoning is never converted into visible activity.

New phone-created tasks default to an isolated per-agent GrantTap workspace.
The phone can instead select a same-agent folder already advertised by a recent
local task. The helper rejects arbitrary unadvertised paths.

Schedules use standard five-field cron in the Mac's timezone. The app supports
hourly, daily, weekday, selected-weekday, and monthly series, plus enable,
disable, edit, delete, and run-now actions. Every run records local start/end
time, agent, status, result, and created task ID.

## CLI commands

| Command | Purpose |
| --- | --- |
| *(no command)* | Starts the GrantTap MCP stdio server |
| `connect [relayUrl]` | Creates an E2EE pairing; optionally targets a self-hosted `wss://` relay |
| `setup` | Registers the Codex/Claude hooks and background helper |

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
where you want GrantTap hooks installed.

## Links

- [GrantTap product site](https://granttap.com)
- [granttap-mcp on npm](https://www.npmjs.com/package/granttap-mcp)
- [Public relay source](https://github.com/sergii-ziborov/granttap-relay)
- [Privacy](https://granttap.com/privacy)
- [Support](https://granttap.com/support)
- [Security policy](SECURITY.md)

GrantTap is not affiliated with Anthropic or OpenAI.
