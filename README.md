# GrantTap MCP

[![npm](https://img.shields.io/npm/v/granttap-mcp)](https://www.npmjs.com/package/granttap-mcp)
[![CI](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Keep Cursor, Claude Code, Codex, GitHub Copilot CLI, and Grok Build moving
from your iPhone or Apple Watch.**

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

- **Real approvals away from the Mac.** Supported provider hooks and gates pause
  the exact agent task; Allow or Deny returns to that same flow.
- **One task view for your local agents.** See recent Cursor, Claude Code,
  Codex, Copilot CLI, and Grok Build tasks,
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

## Install from npm

Install the public command once, pair this computer once, then add the same MCP
server to whichever agents you use:

```bash
npm install -g granttap-mcp@latest
granttap connect
granttap setup
```

`granttap connect` reuses an existing valid machine pairing. Installing GrantTap
for a second agent does not rotate keys or require another QR. Use
`granttap connect --replace` only when you intentionally want a new pairing.

### Add the MCP to each agent

```bash
# Codex
codex mcp add granttap -- npx -y granttap-mcp@latest

# Claude Code (available in every project for this user)
claude mcp add --scope user granttap -- npx -y granttap-mcp@latest

# Grok Build
grok mcp add granttap -- npx -y granttap-mcp@latest
```

Cursor's native **Authorize** button needs the loopback HTTP/OAuth transport:

```bash
granttap authorize
```

For GitHub Copilot CLI, merge this server into `~/.copilot/mcp-config.json`
without removing any existing servers:

```json
{
  "mcpServers": {
    "granttap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "granttap-mcp@latest"]
    }
  }
}
```

The MCP tools (`connect`, `ask`, `ask_yes_no`, `notify`, and `setup`) work in
every client above. Provider-native approvals and mobile chat resume require the
matching local hook/adapter; `granttap status` reports what is actually ready
instead of treating an MCP entry as proof that the provider is online.

Start a fresh agent task and say **“Connect GrantTap.”** The `connect` tool:

1. creates a new end-to-end encrypted pairing;
2. returns a scannable one-time QR directly in the agent chat.

Then run the separate MCP `setup` tool. It installs Cursor shell/MCP policy
hooks, the complete Claude Code matcher, both Codex hooks, and the per-user
background helper for task sync and schedules.

Scan the QR with GrantTap on iPhone. No terminal QR, copied pairing JSON, or
open background terminal is required.

If an MCP client cannot render image content, use the same installed CLI:

```bash
granttap connect
granttap setup
granttap status
```

CLI `connect` prints a one-time QR and short manual code. `setup` is idempotent:
it preserves unrelated agent settings and backs up a configuration file before
changing it. The pairing is stored locally in `~/.granttap/machine.json`.
Existing beta state under `~/.nodvox/` is migrated automatically.

After setup, open `/hooks` in Codex, review and trust both exact GrantTap hooks,
then restart Codex. Installation alone is not reported as trusted or connected.

## Cursor Settings → Authorize

Cursor only shows **Authorize / Sign in** for **HTTP/SSE** MCP servers that
speak OAuth (same pattern as Lovable / Figma). The default stdio entry
(`command` + `args`) cannot show that button — Cursor documents stdio auth as
**Manual**.

To enable Authorize for GrantTap, use the one-step local setup:

```bash
npm install -g granttap-mcp
granttap authorize
```

It preserves unrelated entries in `~/.cursor/mcp.json`, replaces only the
`granttap` entry with the loopback HTTP endpoint, keeps a one-time
`.bak-granttap`, and starts the OAuth MCP server. Then open
**Cursor Settings → MCP → GrantTap → Authorize**. The local consent page shows
the pairing QR plus a manual-token fallback when the Mac is not paired yet.
`granttap authorize` installs a loopback-only per-user LaunchAgent, verifies its
exact `/healthz` identity, writes Cursor config only after that check succeeds,
and exits. The service uses RunAtLoad + KeepAlive, so closing the terminal or
restarting the Mac does not leave Cursor pointing at a dead URL.

The foreground troubleshooting flow is:

1. Run the local HTTP OAuth server (loopback only):

```bash
granttap serve
# listens on http://127.0.0.1:17342/mcp
```

2. Point Cursor at the HTTP URL in `~/.cursor/mcp.json` (replace the stdio
   `command` entry):

```json
{
  "mcpServers": {
    "granttap": {
      "url": "http://127.0.0.1:17342/mcp"
    }
  }
}
```

3. Open **Cursor Settings → MCP → GrantTap** and click **Authorize**.
   A local browser page confirms linking Cursor to this Mac’s pairing
   (`~/.granttap`). If unpaired, it shows a one-time QR first.

OAuth tokens are stored in `~/.granttap/mcp-oauth.json` (mode `0600`). They do
**not** replace E2EE pairing keys. Claude Code / Codex can keep using the
stdio transport; Authorize is a Cursor Settings affordance.

Details: [docs/cursor-authorize.md](docs/cursor-authorize.md).

`granttap setup` is the policy-hook entry point: it installs Cursor
`beforeShellExecution`, `afterShellExecution`, and `beforeMCPExecution` hooks,
plus Claude/Codex hooks and background task sync. It does not opt a new user
into OAuth; when an exact Cursor HTTP entry already exists, it also repairs the
persistent OAuth service. Per-chat blocks are checked before phone routing,
and ambiguous/unscoped Cursor calls fall back to Cursor's native permission UI.

## Provider capability matrix

| Provider | MCP | Native mobile continuation | Approval/policy path |
| --- | --- | --- | --- |
| Codex | stdio | Existing and new tasks | `PermissionRequest` + deny-only `PreToolUse`; trust both in `/hooks` |
| Claude Code | stdio | Existing and new tasks | `PreToolUse` |
| Cursor | loopback HTTP/OAuth or stdio | Not claimed without a supported headless resume adapter | Exact-chat shell and MCP hooks |
| GitHub Copilot CLI | stdio config | Catalog visibility; phone resume is not claimed by this npm release | Native Copilot permission flow |
| Grok Build | stdio | MCP tools are available; ACP mobile turns require the current GrantTap app bridge | Grok ACP plus deny-only safety hook when that bridge is installed |

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
| `setup` | Registers the provider adapters available in this npm release and the terminal-free helper; preserves an existing machine pairing |

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
- Cloudflare accepts at most a 32 MiB WebSocket frame. Because task messages are
  sealed and base64-encoded twice, attachments share a 16,000,000-character
  base64 budget (about 12 MB raw total); five small files fit, five 6 MB files do not.

The in-chat QR is marked user-only for MCP hosts, but that annotation is not a
cryptographic separation from the model provider. Use CLI `connect` when the
model provider itself is part of your threat model; Cloudflare still receives
only the mailbox id and ciphertext in either flow.

The relay can still observe operational metadata: opaque room/mailbox IDs, IP
addresses, timing, ciphertext sizes, and APNs device token/environment. A
compromised authorized endpoint can read the tasks explicitly granted to that
endpoint; cryptography cannot hide plaintext from a device authorized to show
it. The exact boundary and threat-model limits are documented in
[SECURITY.md](SECURITY.md).

## Task sync and scheduling

The background helper publishes a bounded window of supported local provider
task metadata. Older chat metadata is available separately for up
to 90 days and 160 chats; full activity for a task is sent only after the phone
subscribes to it. Hidden reasoning is never converted into visible activity.

Connection health is reported from its own evidence, not from catalog age. The
helper sends a small fixed-cadence heartbeat that no scanning can delay, and the
phone shows **Live** only while that heartbeat is recent. Reading every
provider's transcripts to rebuild the chat catalog can legitimately take far
longer than one heartbeat; treating that as a dead computer used to flip the
phone to "Mac offline" and drop chats that were still valid. A computer that has
genuinely gone away still fails closed, because heartbeat and catalog must both
be stale before the link is called offline.

Scanning is scheduled from completion rather than on a fixed timer, runs one at
a time, and reuses a chat's transcript until that chat itself moves. Periodic
snapshots are sent transiently: they are replaced by the next tick, so holding
them in the relay's durable queue only delayed the current one behind copies
that no longer mattered.

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
| `serve` | HTTP MCP + loopback OAuth for Cursor Settings → Authorize |
| `authorize` | Installs the persistent loopback OAuth service, verifies health, and configures Cursor |
| `connect [relayUrl]` | Creates an E2EE pairing; optionally targets a self-hosted `wss://` relay |
| `setup` | Registers supported local hooks, background sync, and repairs configured OAuth |
| `status [--json]` | Reads local readiness; JSON uses `granttap.provider-status.v1` and contains no keys |

The installed public command is `granttap`; `granttap-mcp` remains an alias for
existing scripts. `status` only reads configuration and runtime state—it does
not install hooks, pair a device, start OAuth, or reload the background helper.
If Cursor has an HTTP GrantTap entry, status requires both an owned persistent
service and a live identity-checked health response; a dead URL is never shown
as connected. Without an HTTP entry, OAuth remains optional and Cursor policy
readiness is based on the full hook set, pairing, and background sync.

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
