# Codex session catalog and activity

Part of GrantTap MCP, licensed under the [MIT License](../../../../../../LICENSE).

Public entry point: [`index.ts`](index.ts). This module reads native Codex
rollouts into GrantTap's Task catalog, root conversation history, nested child
conversations, and observed capability usage.

Titles and user messages use the same visible-text boundary. Host-injected
selected-Page blocks, including a null selection, do not name a Task or appear
as a person's message. A real request next to that context is retained. Ordinary
JSON requests remain visible. Native rollouts are read without modifying the
provider's conversation files.

Tests live in [`tests/`](tests/). The selected-Page regression covers the public
catalog, cached rescans, live activity, and paginated transcript history.
