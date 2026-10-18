# Monitor LaunchAgent environment

`index.ts` carries the saved, checksum-pinned Engine declaration into existing
macOS monitor LaunchAgents. Current launchers also load the declaration through
the cross-platform Engine startup module. Explicit disablement remains owned
by that startup contract.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
