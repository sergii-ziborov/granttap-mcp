# Protocol Messages

This module owns the bounded encrypted message schemas shared by GrantTap clients.
`../schema.ts` is the public entry point and assembles the payload union and relay envelope.

`mesh.ts` adds the Project Mesh contract: stable Project/Task identity, execution
links, TTL resource claims, dependencies, bounded coordination events, and the
Task Capsule plus SHA-256 handoff receipt. `mesh-endpoint.ts` adds the scoped
Grok Bot endpoint, its one-time invite, credential, actors, and revocable policy.
Both are strict schemas: unknown fields are rejected, and transcripts or hidden
model reasoning are outside the contract.

Tests are discoverable in `tests/core.test.ts` and the feature-level bridge and MCP suites.
