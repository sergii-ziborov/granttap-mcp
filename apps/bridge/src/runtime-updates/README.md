# Automatic GrantTap runtime updates

The installed background monitor checks the official `granttap-mcp` npm stable
release every four hours. New versions are installed in a separate private
version directory under `~/.granttap/runtime-updates`, with lifecycle scripts
disabled, Node engine checks enabled, and registry integrity verified. A failed
installation leaves the running version in place.

The stable launcher selects the verified version for future invocations. Owned
background services switch only after their current requests finish and no
approval is pending. Existing provider processes and active stdio MCP calls keep
running. A new service that cannot start restores the previous version; that
failed version is quarantined until a newer release appears.

Pairing, account credentials, task history, capability policy, and provider
installations are not modified by runtime updates. Offline checks retry later.
Source checkouts and test processes do not update themselves. Administrators may
set `GRANTTAP_DISABLE_AUTO_UPDATE=1` on their service to retain their installed
version. Private staging consumes space; old versions are retained for rollback.

Public entry: `startRuntimeUpdates`, `runtimeUpdateReadiness`, and the launcher's
`selection.mjs` / `supervision.mjs` boundary. Tests exercise failed downloads and
verification, deferred activation, concurrent installation, selection, and startup
rollback using isolated directories and owned child processes.

License: [GrantTap Commercial Source License](../../../../LICENSE).
