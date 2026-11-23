# Capability Telemetry

This module identifies MCP, skill, and CLI usage; redacts CLI previews; estimates
bounded context cost; and limits encrypted usage payloads. The wire budget covers the complete status
envelope, including period totals and authenticated room routing, while trimming
only the recent event feed. `index.ts` is
the public entry point. Named secret arguments remain redacted; attached `-p`
values are redacted for password-taking commands rather than ordinary build,
port and path options. An MCP tool call or a skill carries `inputPreview`, what it was
asked in one line of at most 120 characters (`query: disk usage, limit: 5`): arguments read
in order and cut early, a long value at 60 characters, a list as its length, a nested object
elided, secrets redacted as in a command. The phone keeps it with each call, so Usage can
say what an agent asked a server for, not only how often. Behavior tests live in `tests/`, with provider integration
tests in the root `tests/provider/` directory.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
