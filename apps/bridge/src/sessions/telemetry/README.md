# Capability Telemetry

This module identifies MCP, skill, and CLI usage; redacts CLI previews; estimates
bounded context cost; and limits encrypted usage payloads. `../telemetry.ts` is
the public entry point. Tests live in `tests/provider-capability-telemetry.test.ts`
and `tests/provider-capability-bounds.test.ts`.
