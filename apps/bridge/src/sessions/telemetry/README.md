# Capability Telemetry

This module identifies MCP, skill, and CLI usage; redacts CLI previews; estimates
bounded context cost; and limits encrypted usage payloads. `index.ts` is
the public entry point. Named secret arguments remain redacted; attached `-p`
values are redacted for password-taking commands rather than ordinary build,
port and path options. Behavior tests live in `tests/`, with provider integration
tests in the root `tests/provider/` directory.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
