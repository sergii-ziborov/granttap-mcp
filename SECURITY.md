# Security policy

## Reporting a vulnerability

Use GitHub's private
[security advisory form](https://github.com/sergii-ziborov/granttap-mcp/security/advisories/new).
For urgent coordination, contact `sergii.ziborov@gmail.com`.

Do not open a public issue containing pairing codes, device keys, room
identifiers, real prompts, command payloads, local configuration, or a working
exploit. Include the affected package version or commit, expected impact, and
a minimal reproduction using synthetic data.

## Local secrets

Pairing state belongs in `~/.granttap/` and must never be committed, attached
to an issue, or pasted into logs. The package avoids printing device secret
keys. Existing configuration files are backed up before hook installation.

Current pairings contain two independent secret classes: NaCl endpoint keys
that encrypt task content, and a random `pushAuth` room credential that only
authorizes APNs device-token registration at the relay. Neither may be logged.
The relay receives only a hash of `pushAuth` and never receives an endpoint's
secret encryption key.

The delivery ledger and scheduler history are stored only on the paired Mac.
They contain random message ids and local task metadata and are bounded and
expired; do not attach real copies to bug reports.

Relay vulnerabilities should be reported through the
[GrantTap relay advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
