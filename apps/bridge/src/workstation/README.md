# Workstation: load and where the space went

How loaded this computer is and where its disk space went, for the phone's
computer screen (`device.manage` status, `workstation-scan`,
`workstation-settings`) and for agents (`computer_load`). Nothing here deletes
anything.

- `engine.ts` asks Engine 0.1.9 (`workstation.load`, `workstation.space`, linked
  SweepLoom). A space summary takes its own connection and closes it, so its walk
  never queues with the shared connection's short requests. An Engine that
  answers `INVALID_REQUEST` (0.1.8 and older) is not asked again for ten minutes.
- `load.ts` maps the Engine's sample (memory, swap, CPU, the home volume, the
  heaviest apps by name, such as `iOS Simulator`) and otherwise reads the
  operating system: `statfs`, `sysctl vm.swapusage`, `/proc/meminfo`, two CPU
  samples 200 ms apart.
- `space.ts` runs one summary at a time per process; the Engine refuses a second
  across processes, and a busy answer leaves the last summary standing. Without
  the Engine only the agents' own folders are measured, with `du`
  (`source: folders`). The summary is kept in the owner-only `workstation/`
  folder of the GrantTap configuration, with the free space it saw. Chat history
  is `history`, credentials and databases are `protected`; neither is ever
  `regenerable`. The load sheet's agent folders (`machine.load`) are read from
  this summary instead of a `du` of every folder every ten minutes.
- `watch.ts` holds the policy and the five-minute loop, which only the routing
  leader runs. Each tick is one `statfs`. Below 10 GB free the phone hears once
  that space is low, below 3 GB once that it is critical; a level is told again
  only after space came back 5 GB above it, and a restart does not repeat it.
  With `automaticScan: smart` a summary runs on its own only when space is low
  (at most hourly; a busy computer only when critical), when free space dropped
  10 GB since the last summary (at most every half hour), or once a day while the
  five-minute load is under three quarters of the cores and the Mac is on a
  charger; never in the first three minutes after a start. `off` measures only
  when a person or agent asks. `lowSpaceAlert: false` silences the alert.
- `settings.ts` stores `settings.json`, `space.json` and `alert.json` there.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
