# Runtime watchdog

[Monitor](../monitor/README.md) · [Runtime updates](../runtime-updates/README.md)

The monitor is one event loop. If it hangs, nothing inside it can notice. A worker
thread watches a heartbeat the loop writes every second. After 120 seconds without
one, it records a fault, tries to send it to the site, and kills the process so the
service manager starts a clean one.

Restarts are bounded: at most three per hour, counted in a file that survives them.
Past that the process stays up and only reports. Sleep is not a hang: a gap in the
watchdog's own timer starts a fresh grace period. A monitor started by hand reports
and is never killed, because nothing would bring it back.

A report holds only the fault kind, duration, action, restart count, GrantTap version,
Node version, platform and architecture. It never holds a prompt, path, room, key or
computer name. Unsent reports stay in `runtime-watchdog/pending-reports.json` in the
private configuration folder until the site confirms them.
`GRANTTAP_DISABLE_FAULT_REPORTS=1` turns sending off and keeps the local record.

Public entry: `startRuntimeWatchdog`. Tests hang a real process and check the kill,
the spent budget, the sent report and the sleep case.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
