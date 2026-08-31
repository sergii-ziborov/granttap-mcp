# GrantTap MCP

[![npm](https://img.shields.io/npm/v/granttap-mcp)](https://www.npmjs.com/package/granttap-mcp)
[![CI](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sergii-ziborov/granttap-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GrantTap%20Commercial-7c3aed.svg)](LICENSE)

GrantTap is a Personal live control center for local coding agents.

> See what your coding agents are doing. Step in when they need you.

This repository is the canonical machine runtime: CLI, MCP server, provider
hooks, local adapters, and TypeScript wire schemas. Agents and provider
credentials stay on your computer. Native iPhone and Apple Watch traffic is
end-to-end encrypted.

The source is public for inspection and contribution, but GrantTap MCP is
proprietary paid software rather than open source. Production use requires an
active GrantTap subscription or a separate commercial agreement.

[Website](https://granttap.com) · [npm](https://www.npmjs.com/package/granttap-mcp) ·
[Security model](SECURITY.md) ·
[Relay source](https://github.com/sergii-ziborov/granttap-relay)

## iPhone and Apple Watch

<p align="center">
  <img src="docs/images/iphone-command-center.png" width="230" alt="GrantTap Now with Needs You and at-risk tasks">
  <img src="docs/images/iphone-chat.png" width="230" alt="GrantTap live task timeline and composer">
  <img src="docs/images/iphone-mcp-usage.png" width="230" alt="GrantTap actionable usage overview">
</p>

<p align="center">
  <img src="docs/images/apple-watch-inbox.png" width="180" alt="GrantTap Needs You on Apple Watch">
  <img src="docs/images/apple-watch-approval.png" width="180" alt="GrantTap approval on Apple Watch">
</p>

## Supported providers

- Primary: Claude Code and Codex.
- Beta: Cursor.
- Experimental where available: Grok Build.

GrantTap reports the depth each provider actually exposes. Visibility does not
imply deterministic remote blocking or full mobile continuation.

## Project Mesh and task handoff

Project Mesh adds stable Project and Task identity above provider-native
sessions. A Task can retain its `taskId` across multiple executions, agents,
and computers while each native session remains intact.

Agents publish bounded progress, dependency, question, answer, claim, conflict,
and completion events through the existing `notify` tool, and read state from a
Mesh resource. Full transcripts and hidden reasoning are never mesh payloads.
Claims have TTLs; a colliding claim is rejected before it is recorded so agents
can choose different work or contact the owner before escalating to Needs You.

For Claude Code, Codex, and Cursor, the provider hook runs inside the agent's
own session and sees the exact call. GrantTap attributes every `notify` to the
session that really made it and publishes the event only for that execution —
a model that learned another session's id cannot act in its name.
`granttap://mesh/current` therefore carries no Project data: an attributed call returns this execution's opaque
`granttap://mesh/<capability>` URI, and only that URI serves its Project, Task,
owners, claims, dependencies, and relevant events. Ownership transfer stays out
of the tool surface entirely: `HANDOFF_ACCEPTED` and `HANDOFF_REJECTED` are
decided by the runtime after receipt verification.

The first executable handoff path is Claude Code ↔ Codex across linked
computers. GrantTap builds a bounded Task Capsule from explicit task/git facts,
requires local phone authorization, creates a separate target branch/worktree,
starts the target execution, and returns a receipt bound to the exact capsule.
Cursor uses the same provider-neutral schema and trusted caller attribution.
Grok Build remains Experimental and observable where available, but does not
yet expose a trusted caller hook, so agent-authored scoped Mesh events are not
offered for it. Unsupported remote-start paths fail closed instead of claiming
parity.

A capsule carries facts, not files. A handoff from a checkout with uncommitted
changes is refused — "This task has uncommitted changes. Commit or checkpoint
them before moving the task." — instead of silently continuing the Task from
committed state and leaving that work behind. The destination is refused just
as explicitly when the named commit is not on its computer, or when the
capsule's own resource claims overlap another execution's; GrantTap never
pushes or fetches on its own.

### Grok Bot as a scoped Mesh participant

Grok Bot is a persistent agent, not a coding-agent integration. The iPhone
issues a one-time encrypted Mesh Invite scoped to the Projects you select, and
the invite is redeemed on the trusted CLI:

```bash
granttap mesh connect <one-time-invite>
```

Grok Bot then runs `granttap internal mesh-mcp`, a separate scoped MCP server
that exposes only the twelve task-scoped Mesh operations. It cannot create
invites, change the relay, expand Project scope, or reach `setup`; revoking the
endpoint from the iPhone stops new Mesh operations immediately while local Task
history stays on the device.

## Install

Installation and production use require Authorized Access under the
[GrantTap Commercial Source License](LICENSE).

```bash
npm install -g granttap-mcp
granttap setup
```

`granttap setup` detects supported local agents, installs or repairs their
hooks, installs the background helper, configures Cursor's persistent local
OAuth service when Cursor is present, and starts phone pairing when run in an
interactive terminal. It ends with one exact next action.

The normal CLI surface is intentionally small:

```text
granttap setup
granttap status [--json]
granttap connect [--relay <wss-url>]
granttap reset [--yes]
granttap mesh connect <one-time-invite>
```

`connect` reuses a valid pairing. If none exists, it creates a one-time QR.
Custom relays are CLI-only and explicit. `reset` moves active pairing files to
recoverable local backups before a new pairing can be created.

Cursor setup is automatic in the normal flow. The advanced repair command is:

```bash
granttap cursor repair
```

After Codex hooks are installed, open `/hooks`, review and trust both exact
GrantTap hooks, then restart Codex. GrantTap never treats installation as user
trust.

## MCP contract

`tools/list` returns exactly four public tools:

| Tool | Contract |
| --- | --- |
| `connect` | Reuse the existing production pairing or return a one-time QR |
| `notify` | Send a non-blocking status update of at most 2,000 characters |
| `ask_yes_no` | Ask a yes/no question and wait for the explicit answer |
| `ask` | Ask an open question and wait for typed or spoken text |

MCP `connect` accepts no custom routing, replacement, or key-rotation input.
Setup is CLI-only because it changes provider configuration and must not be
available to a model through prompt injection.

`notify` may alternatively carry one bounded task-scoped Mesh event. This does
not add a fifth MCP tool or grant any global setup capability, and it publishes
only for the execution whose provider hook attributed the call.

Provider-native approvals and mobile continuation require the matching local
adapter. MCP registration alone is never reported as proof that an integration
is ready.

## What the runtime publishes

The bounded encrypted protocol preserves:

- provider, task, computer, model, workspace, branch, state, and summary;
- visible activity, delivery state, context and token counters;
- MCP, Skill, and CLI observations;
- child-agent relationships;
- per-capability outcome: `success`, `error`, `cancelled`, or `unknown`.

An optional bounded `errorClass` may describe an error category. Full tool
error payloads are not copied into usage telemetry by default.

## Local enforcement

GrantTap can narrow later actions for an exact task only where a provider
offers a deterministic local hook. Global provider configuration always wins.
Read-only integrations stay read-only in the app instead of presenting a fake
toggle.

The user-facing approval modes map to the existing runtime policy:

| Personal UI | Runtime |
| --- | --- |
| Ask for risky actions | `except_push` |
| Ask for every action | `ask` |
| Use agent defaults | no GrantTap gate for that task |

Legacy custom levels remain compatible but are not part of the primary flow.

## Relay boundary

Pairing and task keys are generated locally. The relay receives opaque routing
metadata and ciphertext, not provider credentials or task plaintext. Pairing
handoff uses a relay-visible random mailbox ID plus an independent transfer key
that stays in the QR.

APNs carries a content-neutral wake only. It contains no prompt, task title,
command, path, request ID, or ciphertext. See [SECURITY.md](SECURITY.md) for the
complete boundary and reporting instructions.

## Development

```bash
npm install
npm run typecheck
npm test
npm run package:allowlist
npm run test:coverage   # macOS only — see below
```

`npm test` runs everywhere. Both suites run with an isolated `HOME`, so a
developer's own Claude/Codex/Cursor data can never inflate a local result: the
numbers on this machine and in CI are the same. The coverage contract is
measured on macOS because the background helper, the Cursor OAuth service, and
the installer only execute there, so a Linux percentage understates real
runtime coverage. CI runs the cross-platform suite on Linux and the coverage
gate on macOS, and `npm publish` enforces the same gate through
`prepublishOnly`.

Do not publish from a dirty checkout or before the package allowlist, tests,
typecheck, and release checks pass.

## License

GrantTap MCP is distributed under the proprietary
[GrantTap Commercial Source License 1.0](LICENSE). Public source access does not
grant open-source, redistribution, hosted-service, or competing-product rights.
Third-party dependencies retain their own terms; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

GrantTap is not affiliated with Anthropic, OpenAI, Apple, Anysphere, or xAI.
