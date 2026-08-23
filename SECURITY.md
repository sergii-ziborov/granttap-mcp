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

## Cryptographic boundary

- Every computer pairing is generated locally with unique Curve25519 keys.
- Pairing handoff uses an opaque 128-bit mailbox ID and an independent 256-bit
  transfer key. The relay receives the mailbox ID and ciphertext, not the key.
- Each attached task has an independent 256-bit task key. One task key cannot
  decrypt another task.
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

## Runtime controls

Provider hooks enforce policy on the computer. Global provider deny always
wins. If a provider cannot deterministically block a capability, GrantTap must
report the observation as read-only instead of implying enforcement.

`setup` is CLI-only because it writes local provider configuration and installs
background services. The public MCP server can only connect an existing or new
phone pairing, notify, and ask bounded questions; it cannot reconfigure the
machine or select a custom relay.

Relay vulnerabilities should be reported through the
[GrantTap relay advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
