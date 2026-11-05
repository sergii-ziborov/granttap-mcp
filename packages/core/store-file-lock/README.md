# Store file lock

Public entry: `index.ts`. `withStoreLock(path, work)` serializes synchronous local
store mutations with an exclusive directory lock and checks the owning token on
release. A dead owner can be reclaimed; a live owner is never removed by elapsed
wall time. Callbacks must not return promises. `StoreLockError` reports bounded
lock contention. The Mesh store and durable task inbox share this primitive.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
