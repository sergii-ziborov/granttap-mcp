# Provider storage on this Mac

Public entry: `ProviderStorage.read`, exposed only as `desktop.provider_storage`
on the same-user Unix desktop channel or authenticated native loopback grant.
It is not a provider MCP tool or a remote phone cleanup capability.

Install the separately licensed [SweepLoom CLI](https://github.com/Weavatrix/sweeploom)
with its MCP feature. The scanner locates `~/.local/bin/sweeploom`,
`~/.cargo/bin/sweeploom`, Homebrew locations or `GRANTTAP_SWEEPLOOM_PATH`.
Only `list_ai_stores` and `list_sessions` metadata tools are called. SweepLoom
is MPL-2.0 and is neither copied into nor bundled with GrantTap’s MIT package.

Inspect returns Codex, Claude and Cursor storage categories, logical sizes and
an unselected short-lived review. History, credentials, SQLite, settings, skills
and context are inspect-only. Capped inventories, symlink trees and running
provider processes block cache selection. No file contents are read.

A confirmed selection contains opaque review ids, never filesystem paths.
The review expires after five minutes and is consumed once. The runtime checks
provider activity and a complete bounded metadata fingerprint before moving
only the chosen Cache/Log trees to the same Mac’s system Trash using rename.
It does not permanently delete files or terminate any process. A changed tree
requires a fresh review. Cache cleanup does not change capability approvals.

Tests in `tests/storage.test.ts` use isolated provider roots and system-Trash
fixtures; they never clear the developer’s provider state.

This GrantTap module is distributed under the MIT License. SweepLoom retains
its separate MPL-2.0 license.
