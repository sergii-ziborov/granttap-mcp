# Engine startup

`index.ts` exposes saved-declaration activation and platform-specific endpoint
selection. The launcher preloads `activation-entry.ts` after registering tsx and
before importing a hook, service or monitor. It performs no network access or
Engine installation. The runtime supervisor verifies the selected executable
before launch. Windows endpoints are local owner-scoped named pipes; Unix
endpoints retain the configured socket path.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
