# Linux background services

`index.ts` owns the two GrantTap per-user systemd units. Setup installs the
monitor and loopback MCP service into the current user's unit directory and
starts only those named units. Existing foreign units and symlinked unit files
are refused. A failed repair restores the prior owned definition and its
enabled/running state where the user manager remains reachable.

No root installation, system service, lingering setting or unrelated unit is
changed. Systems without a reachable user systemd manager keep an explicit
manual state rather than claiming background sync is running. The service runs
while that user session exists; administrators can configure lingering outside
GrantTap if unattended operation after logout is needed.

Paths are quoted, percent specifiers are escaped, environment expansion is
disabled in ExecStart and no shell interprets the command. Both services load
the persisted Engine declaration through the shared launcher preload.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
