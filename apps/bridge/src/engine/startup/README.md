# Engine startup

`index.ts` exposes saved-declaration activation and platform-specific endpoint
selection. The launcher preloads `activation-entry.ts` after registering tsx and
before importing a hook, service or monitor. It performs no network access or
Engine installation. The runtime supervisor verifies the selected executable
before launch. Windows endpoints are local owner-scoped named pipes; Unix
endpoints retain the configured socket path.

The paired monitor uses `startEngineRecovery` to prepare its managed Engine in
parallel with the first catalog, retry offline preparation and supervise helper
restarts. Graph recovery follows catalog delivery. This background loop is not
loaded by provider hooks; a stopped loop cannot start a late graph recovery.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
