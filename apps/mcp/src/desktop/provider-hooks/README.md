# Desktop Codex hook review

Public entry point: [`index.ts`](index.ts). The existing private desktop Engine
socket exposes `desktop.codex_hook_trust` for a person to approve a displayed
GrantTap hook. This operation delegates current-definition validation, scoped
writes, and native confirmation to the bridge's Codex hook review module.

Malformed requests are rejected. Expired requests and other computers return
correlated failure receipts without creating identity or changing hook state.
This operation is not exposed as a public HTTP mutation or an agent tool.
Tests live in `tests/`.

## License

This module is distributed under the MIT License. See the repository LICENSE.
