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

Identical full session snapshots share one in-flight capability scan across relay
clients. A completed observation is reused for one second, retaining its original
`generatedAt`; changed session metadata gets an independent read immediately.
Inputs are snapshotted before asynchronous work, rejected reads are retryable,
and the cache holds at most 16 scopes. Room attribution is still applied per
recipient after reading. Foreground usage requests retain their existing direct
reader. This removes repeated parsing without changing totals or unknown-use
semantics. `tests/shared-reader.test.ts` covers sharing, scope separation,
concurrent input changes, expiration, retry and bounded retention.
