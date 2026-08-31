# Machine load

This module samples coding-agent process families without rescanning provider
catalogs. `index.ts` assembles and publishes the bounded wire payload,
`process-sampler.ts` owns asynchronous process discovery, `scan-cost.ts` retains
the latest provider discovery cost, and `loop.ts` runs the independent adaptive
five-second active / thirty-second idle cadence from cached session status.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
