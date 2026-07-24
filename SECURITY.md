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

Relay vulnerabilities should be reported through the
[GrantTap relay advisory form](https://github.com/sergii-ziborov/granttap-relay/security/advisories/new).
