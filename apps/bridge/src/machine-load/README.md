# Machine load

This module samples coding-agent process families without rescanning provider
catalogs. `index.ts` assembles and publishes the bounded wire payload,
`host/process-sampler.ts` owns agent ancestry, `host/ps-reader.ts` reads operating-system
CPU time and RSS, `mcp/scan-cost.ts` retains provider discovery cost, and `host/loop.ts`
runs a two-second active / thirty-second idle cadence from cached session status.

`command-process/history.ts` hashes process command fingerprints and uses
the provider's existing call/result timestamps to match one newly started
command process and its descendants. It sums OS cumulative CPU time and takes
the highest sampled tree RSS. Ambiguous, stale, and undersampled calls do not
claim an isolated measurement. The same-user desktop worker reads a bounded
0600 cache of those samples; it contains hashes and process counters, never
command text. `host/agent-load-history.ts` supplies a distinctly approximate
share of agent process load when an isolated tree cannot be matched.

Neither path sends a prompt or asks the agent to report resources. Context
token estimates come from existing call arguments and results. Exact model
tokens belong to provider replies and are not allocated to individual OS
commands.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
