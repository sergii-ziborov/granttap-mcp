# Machine load

This module samples coding-agent process families without rescanning provider
catalogs. `index.ts` assembles and publishes the bounded wire payload,
`process-sampler.ts` owns asynchronous process discovery, `scan-cost.ts` retains
the latest provider discovery cost, and `loop.ts` runs the independent adaptive
five-second active / thirty-second idle cadence from cached session status.

`host/agent-load-history.ts` integrates the bounded rolling samples over a
completed call and retains the integration window as `sampleWindowMs`. Clients
can derive average CPU relative to one core from CPU time divided by this window.
These resources remain attributed shares of provider process families, divided
by concurrent lanes, rather than isolated command measurements. The desktop
task-activity projection preserves this evidence and estimated context size;
context estimates are not per-command model token billing.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
