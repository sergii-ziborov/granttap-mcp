# Security policy

## Reporting a vulnerability

Use GitHub's private
[security advisory form](https://github.com/sergii-ziborov/granttap-mcp/security/advisories/new).
For urgent coordination, contact `sergii.ziborov@gmail.com`.

Do not open a public issue containing pairing tokens, device keys, room
identifiers, real prompts, command payloads, local configuration, or a working
exploit. Include the affected package version or commit, expected impact, and
a minimal reproduction using synthetic data.

## Local secrets

Pairing state belongs in `~/.granttap/` and must never be committed, attached
to an issue, or pasted into logs. The package avoids printing device secret
keys. Existing configuration files are backed up before hook installation.

Current pairings contain three independent secret classes: NaCl endpoint keys,
random per-task keys, and a random `pushAuth` room credential that only
authorizes APNs device-token registration at the relay. None may be logged.
The relay receives only a hash of `pushAuth` and never receives an endpoint's
secret encryption key.

## Cryptographic boundary

- Every device pairing is generated locally and has unique Curve25519 secret
  keys. A device from another pairing cannot authenticate or decrypt it.
- Pairing hand-off v2 uses a relay-visible random 128-bit mailbox id and a
  separate random 256-bit transfer key. Only the mailbox id is used in the HTTP
  path. The key stays in the QR/manual token, so a relay operator or a Durable
  Object database dump cannot open the parked pairing blob.
- Every attached Codex or Claude Code task receives a separate random 256-bit
  task key. Task messages, attachments, visible activity, access/MCP changes,
  compaction results, and task-bound approvals use this additional authenticated
  encryption layer. A key copied from one task cannot decrypt another task.
- Task keys are delivered only inside the already authenticated device-to-device
  NaCl channel and are stored in device-only Keychain on iOS and a mode `0600`
  file on the agent Mac.
- APNs is only a content-neutral wake. It contains no task kind, request id,
  delivery id, title, prompt, command, path, or response.

Cloudflare can observe service metadata required to operate the relay: an
opaque room/mailbox id, routing role, timestamps/expiry, IP address, ciphertext
size, APNs device token/environment, and a content-neutral wake flag. It cannot
derive plaintext from those fields or from its stored database.

The honest limit: a device can decrypt every task key that was explicitly
granted to that device. Cryptography cannot both authorize a device for a task
and prevent that same device from reading it. Compromise of the agent Mac is
also outside the relay threat model because the Mac necessarily has the local
agent transcripts and keys. The isolation guarantee is against Cloudflare,
database/network compromise, other pairings/devices, and disclosure of a
different task's key—not against an already authorized endpoint.

The delivery ledger and scheduler history are stored only on the paired Mac.
They contain random message ids and local task metadata and are bounded and
expired; do not attach real copies to bug reports.

Relay vulnerabilities should be reported through the
[GrantTap relay advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
