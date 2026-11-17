# Automatic GrantTap runtime updates

The installed background monitor checks the official `granttap-mcp` npm stable
release once an hour: one small, bounded registry request (`/granttap-mcp/latest`, at most
256 KB, ten-second timeout). A release the registry named is reused for that hour, so a busy monitor that
looks again each minute for an idle moment sends no further request. A failed check is retried after 5,
10, 20 and 40 minutes, then hourly. New versions are installed in a separate private
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

Phone messages keep arriving and phone chats run turns that last hours, so a monitor in daily use may
not be idle for days: one computer stayed on an old release for more than a day while three newer ones
waited. Two mechanisms bound the wait.

**Chats' turns are handed over, not waited for.** A phone delivery's provider run writes to files in a
folder of its own and leads its own process group, so it outlives the monitor; the next monitor finds it
by pid and start time, holds its chat as before, and delivers its answer when it ends
([`../reply/survival`](../reply/survival/README.md)). Such a run does not hold an update back once the
provider took the prompt and the message is past its three-second acceptance window. Nothing is
stopped: the turn keeps running across the switch.

**The rest is drained.** `drain/index.ts` (`UpdateDrain`) gives the update a bounded way in past the work
that cannot be handed over. A busy monitor starts the staged release once to verify it. If it works,
the monitor stops starting queued phone messages: they stay staged on this computer and unclaimed on
the relay. Every five seconds the monitor asks whether that work has ended; the pass that finds it ended
selects the release and tells the launcher, without asking the registry first. New work stays held
until the launcher replaces the monitor, so the new runtime delivers what arrived meanwhile and no
message is claimed by a process that is about to exit. From the moment the launcher is told, a chat's
run that ends leaves its answer on disk for the next monitor.

Work that holds an update back: a relay command or a queued delivery whose handler has not returned, a
provider run that cannot be handed over (a moved Task's turn, a Cursor conversation, a Codex desktop
delivery, a turn not yet past acceptance or not yet confirmed by Grok), a phone message waiting in memory
behind a running turn of its chat, an answer being sent, a pending approval, a provider sign-in, or a
maintenance action.

| Bound | Value |
| --- | --- |
| A chat's turn that has started | handed over; it does not delay the update |
| New messages wait in one hold | 10 minutes at most, usually seconds |
| Pause after a first hold gave up | 5 minutes, and until the runs that outlasted it have ended |
| Pause after a second hold in a row, or one no run outlasted | 30 minutes |
| Launcher replaces the monitor after being told | 2 minutes, then messages run again and held answers are sent here |
| A release that failed its start check is started again | after 30 minutes |

With phone chats running all day, an update therefore takes over within seconds to minutes of being
staged, bounded by the ten-minute hold: the update check runs every hour, and a staged release is
held for as soon as it is verified. Only work that cannot be handed over can make a hold give up, and
then the earlier behaviour applies: other chats are delayed once by ten minutes, and the update follows
within minutes of that work ending.

The trade-off: a run handed over is judged by its output alone when the old monitor did not see it
exit, so an answer counts only if the provider reported the end of its turn; a run killed during the
switch is reported as stopped before it finished. Output lives in a private file until its answer is
sent, instead of in memory. A Windows computer keeps pipes and the drain alone.
`GRANTTAP_RUN_SURVIVAL=0` on the service does the same anywhere.

The launcher's own question (`granttap.runtime-update-check`, sent while a newer runtime is selected)
starts the same hold, so a release selected from the phone does not wait for an idle moment either.
Direct relay commands are not held: a reply to a provider's question is what lets a running turn end.
The monitor log has one `[monitor] Update … is ready` line when a hold starts (with the number of
running chats it will take over), one `… still waits` line naming what it waited for when it gives up,
one `… takes over` line when the update activates, and in the new monitor a `Taking over a run …` line
for each run it adopts.

### Why an update waits, outside the monitor

The monitor writes its hold to `runtime-updates/hold.json` (`drain/state.ts`) on every change and every
poll while it lasts, and clears it on start; the file names the monitor process, and once that process
is gone it says nothing. `UpdateHold`:

| Field | Meaning |
| --- | --- |
| `version` | The release that waits |
| `phase` | `holding` (new phone messages wait), `handing-over`, `waiting` (the last hold gave up, or the next cannot start yet), `start-check-failed` |
| `since`, `holdUntil` | When the hold began, and when it gives up at the latest |
| `nextAttemptAt`, `afterRunsEnd` | When the next hold may start, and whether it also waits for the runs the last one waited for |
| `attempts` | Holds given up in a row for this release |
| `blockers` | What cannot be handed over: `run` (by chat `sessionId`, or `newTask` provider, with `since`), `answer`, `approval` (`count`), `sign-in`, `maintenance`, `command` (`count`) |
| `survivingRuns` | Chats whose turns keep going and are taken over by the new release |

`pendingRuntimeUpdate` reads the version cache and that file without writing: a newer release selected
while older processes still run, or one downloaded and not yet selected, with `hold` and a sentence
saying what it waits for, since when, and when it comes back. `connection_status` returns it as
`pendingUpdate.hold`; the phone's computer status (`device.manage` `status` snapshot) carries the same as
`runtimeUpdateHold`, plus `summary`, the sentence.

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

Public entry: `startRuntimeUpdates`, `pendingRuntimeUpdate`, `runtimeUpdateReadiness`, `UpdateDrain`, and the
launcher's `selection.mjs` / `supervision.mjs` boundary. Tests exercise failed downloads
and verification, deferred activation, concurrent installation, selection, and startup
rollback using isolated directories and owned child processes. `drain/tests` covers the
hold's bounds, activation while messages keep arriving, the launcher handoff, and what the hold reports
(`report.test.ts`); `tests/monitor/lifecycle/update-switch.test.ts` runs the whole switch while a real
provider run goes on, and the new runtime delivers its answer.

License: [GrantTap Commercial Source License](../../../../LICENSE).
