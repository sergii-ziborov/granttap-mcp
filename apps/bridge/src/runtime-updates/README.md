# Automatic GrantTap runtime updates

The installed background monitor checks the official `granttap-mcp` npm stable
release every four hours. New versions are installed in a separate private
version directory under `~/.granttap/runtime-updates`, with lifecycle scripts
disabled, Node engine checks enabled, and registry integrity verified. A failed
installation leaves the running version in place.

The stable launcher selects the verified version for future invocations.
Provider hooks keep the launcher path they were written with: `cachedHookLauncher`
treats an earlier cached launcher as current, so status stays ready and setup
leaves the hook (and the trust Codex keeps per command) alone after an update. Owned
background services switch only after their current requests finish and no
approval is pending. Existing provider processes and active stdio MCP calls keep
running. A new service that cannot start restores the previous version; that
failed version is quarantined until a newer release appears.

## Draining a busy monitor

Phone messages keep arriving, so a monitor in daily use may not be idle for hours.
`drain/index.ts` (`UpdateDrain`) gives the update a bounded way in. A busy monitor
starts the staged release once to verify it. If it works, the monitor stops
starting queued phone messages: they stay staged on this computer and unclaimed
on the relay. Provider runs already going are never stopped. Every five seconds
the monitor asks whether its work has ended; the pass that finds it ended selects
the release and tells the launcher, without asking the registry first. New work
stays held until the launcher replaces the monitor, so the new runtime delivers
what arrived meanwhile and no message is claimed by a process that is about to exit.

Work in flight means: a relay command or a queued delivery whose handler has not
returned, a provider run this monitor started, the answer of such a run that is
still being sent, a pending approval, a provider sign-in, or a maintenance action.

| Bound | Value |
| --- | --- |
| New messages wait in one hold | 10 minutes at most |
| Pause after a first hold gave up | 5 minutes, and until the runs that outlasted it have ended |
| Pause after a second hold in a row, or one no run outlasted | 30 minutes |
| Launcher replaces the monitor after being told | 2 minutes, then messages run again |
| A release that failed its start check is started again | after 30 minutes |

A run that lasts hours therefore delays other chats once, by ten minutes, and the
update follows within minutes of that run ending. The launcher's own question
(`granttap.runtime-update-check`, sent while a newer runtime is selected) starts the
same hold, so a release selected from the phone no longer waits for an idle moment
either. Direct relay commands are not held: a reply to a provider's question is
what lets a running turn end. The monitor log has one `[monitor] Update … is ready`
line when a hold starts, one `… still waits` line when it gives up, and one
`… takes over` line when the update activates.

Pairing, account credentials, task history, capability policy, and provider
installations are not modified by runtime updates. Offline checks retry later.
Source checkouts and test processes do not update themselves. The plugin's
connection card offers a persistent **Automatic updates: On / Off** switch for
this computer. The running monitor reads it before registry checks and activation;
the launcher checks it again before handing off an owned service. Off keeps the
current selected runtime and rollback protection. An in-progress download may
finish staging but cannot activate while off. Re-enabling is observed on the next
minute tick without restarting services. Administrators may
set `GRANTTAP_DISABLE_AUTO_UPDATE=1` on their service to retain their installed
version. Private staging consumes space; old versions are retained for rollback.

Public entry: `startRuntimeUpdates`, `runtimeUpdateReadiness`, `UpdateDrain`, and the
launcher's `selection.mjs` / `supervision.mjs` boundary. Tests exercise failed downloads
and verification, deferred activation, concurrent installation, selection, and startup
rollback using isolated directories and owned child processes. `drain/tests` covers the
hold's bounds, activation while messages keep arriving, and the launcher handoff;
`tests/monitor/lifecycle/update-switch.test.ts` runs the whole switch with a real provider run.

License: [GrantTap Commercial Source License](../../../../LICENSE).
