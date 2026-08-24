# Security policy

## Reporting a vulnerability

Use GitHub's private
[security advisory form](https://github.com/sergii-ziborov/granttap-mcp/security/advisories/new).
For urgent coordination, contact `sergii.ziborov@gmail.com`.

Do not open a public issue containing pairing tokens, device keys, room IDs,
real prompts, command payloads, APNs tokens, local configuration, or a working
exploit. Use synthetic data and include the affected package version or commit.

## Local secrets

Pairing state belongs in `~/.granttap/`. It must never be committed, attached
to an issue, or printed in logs. The active secret classes are endpoint NaCl
keys, per-task keys, the one-time pairing transfer key, and the random room
credential used for authenticated WebSocket and APNs registration.

Provider credentials remain in each provider's own local authentication flow.
GrantTap does not send them to the relay.

Installed Claude Code, Codex, and Cursor hooks deny direct agent tool calls
that name GrantTap's local pairing or policy directory, including calls that
would otherwise be auto-accepted or run in provider bypass mode. This is
best-effort self-protection, not an operating-system security boundary: a
process running as the same macOS user can use an unobserved tool, shell
obfuscation, or direct filesystem access outside those hooks. Protect the user
account and disk; use a trusted terminal for intentional maintenance. Moving
remaining local secret material into Keychain is the stronger future boundary.

## Cryptographic boundary

- Every computer pairing is generated locally with unique Curve25519 keys.
- Pairing handoff uses an opaque 128-bit mailbox ID and an independent 256-bit
  transfer key. The relay receives the mailbox ID and ciphertext, not the key.
- Each attached task has an independent 256-bit task key. One task key cannot
  decrypt another task.
- Project Mesh snapshots have independent project keys. Cross-computer events
  remain under their Task key, and a linked destination receives either key
  only through an explicit phone-mediated route.
- Task keys travel only inside the authenticated device channel and are stored
  in device-protected storage.
- Native phone/watch payloads remain authenticated ciphertext across the
  network, Cloudflare, Durable Objects, and the offline queue.
- APNs is a neutral wake. It contains no prompt, task title, command, path,
  task/request/delivery ID, or task ciphertext.
- MCP audience annotations are not a cryptographic model-provider boundary.
  Use CLI `granttap connect` when the model provider itself is in the threat
  model.

Cloudflare can observe operational metadata required to run the relay: opaque
room/mailbox IDs, routing role, IP address, timing, expiry, ciphertext size, and
APNs token/environment. It cannot decrypt task content from those fields.

The honest endpoint limit remains: a compromised device can read the tasks
whose independent keys were granted to it. The protection is against relay,
database/network compromise, other pairings, and disclosure of a different
task key—not against an endpoint already authorized for that task.

Project Mesh reads and writes are scoped to one execution. The MCP server
cannot see which agent called it, so the provider hook — which runs inside the
session and receives the exact arguments — records a single-use attribution for
that call, and the runtime publishes the event for that session only. A model
that learned another execution's session id, Project, or Task cannot publish in
its name, and the unscoped `granttap://mesh/current` URI carries no Project
data at all. The opaque capability returned to an attributed caller names one
Project, Task, session and provider, expires, and never authorizes ownership
transfer.

Task Capsules are strict, bounded schemas containing goal, explicit status,
repository/commit facts, changed-file names, tests, dependencies, claims,
remaining work, and explicit decisions. Unknown fields are rejected; hidden
reasoning and transcript replication are outside the contract. Handoff
acceptance includes a SHA-256 receipt over a canonical capsule and the source,
target, Task identity, and acceptance time. Stale claims expire, replayed event
IDs are ignored, and destination routing is explicit.

Repository remotes included in Project snapshots are reduced to lowercase
host/path form. Userinfo, passwords or tokens, query strings, fragments, and
local-path remotes are never persisted as `baseRemote`.

## Runtime controls

Provider hooks enforce policy on the computer. Global provider deny always
wins. If a provider cannot deterministically block a capability, GrantTap must
report the observation as read-only instead of implying enforcement.

`setup` is CLI-only because it writes local provider configuration and installs
background services. The public MCP server can only connect an existing or new
phone pairing, notify, and ask bounded questions; it cannot reconfigure the
machine or select a custom relay.

A Grok Bot endpoint is a separate scoped identity. Its one-time invite is
created only on the iPhone, stored on the relay as ciphertext, redeemed only by
the trusted `granttap mesh connect` CLI, and written to disk with `0600`
permissions. Its MCP server exposes only task-scoped Mesh operations bound to
one credential: every call re-checks endpoint, credential, policy revision,
expiry, actor, Project scope, and operation, and a revoked or disabled endpoint
fails closed. Invite creation, actor enablement, Project scope, and revocation
stay in the iPhone UI and the trusted CLI, never in a model-callable tool.

Relay vulnerabilities should be reported through the
[GrantTap relay advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
