# Codex hook review

Public entry point: [`index.ts`](index.ts).

GrantTap reads native Codex `hooks/list` metadata to distinguish configuration,
current-definition trust, and enabled state. Only the two exact user hooks
installed by this runtime (`PreToolUse` and `PermissionRequest`) can be reviewed.
Project, plugin, managed, ambiguous, or unrelated commands are never approved.
Unsupported native APIs report unknown; configured hooks alone do not establish
readiness or computer enforcement.

The monitor and desktop status endpoint share a bounded cache. Computers with no
GrantTap hook definition do not start Codex. When a native status probe is needed,
Codex may maintain its own runtime caches; GrantTap does not edit hook configuration
or trust during inspection. The subprocess starts no threads or turns.

A person approves one displayed definition on one computer. `trustCodexHook`
checks the computer, five-minute request lifetime, native key, and current hash,
then uses Codex's `config/batchWrite` API to save that hash and enabled state.
Success requires a fresh native report confirming the same key and hash are
trusted and enabled. Modified definitions require a new review. No bulk trust,
sandbox bypass, or approval-policy change is performed.

Remote requests require the paired controller and matching room. Results return
only to that controller. Mac uses the existing private desktop Engine socket.
Legacy clients retain their configuration status without claiming native trust.

Tests live in `tests/`. The native integration test runs only when
`GRANTTAP_CODEX_TEST_BIN` names a Codex binary and uses a temporary Codex home.
It never trusts hooks in the user's configuration.

## License

This module is distributed under the MIT License. See the repository LICENSE.
