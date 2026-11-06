# Monitor LaunchAgent environment

`index.ts` carries the saved, checksum-pinned Engine declaration into existing
macOS monitor LaunchAgents. Current launchers also load the declaration through
the cross-platform Engine startup module. Explicit disablement remains owned
by that startup contract.

The live monitor uses `ProcessType=Interactive`: the phone depends on timely
heartbeats and approval replies over WebSocket, without XPC transactions that
could raise an Adaptive job's priority. The installer marks older Background
definitions for repair. This follows [Apple's launchd process classification](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
