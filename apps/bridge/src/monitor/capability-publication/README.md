# Usage publication

Public entry: `index.ts`. Complete capability totals are computed from the live
catalog and full discovered history. This work has one independent in-flight
publication per relay client. A slow history read or encrypted fan-out does not
hold the current chat catalog. Successful reports retain their existing cadence;
failures retry on a later catalog publication. Closing the monitor prevents
further queued reads and sends. Counts and unknown usage semantics are unchanged.
Concurrent catalog and Usage requests share one in-flight history read. The
history cache's lifetime begins when that read completes.

Behavior tests live in `tests/`.
Licensed under the GrantTap Commercial Source License in the repository root.
