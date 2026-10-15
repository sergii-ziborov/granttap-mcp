# Store file lock

Public entry: `index.ts`. `withStoreLock(path, work)` serializes synchronous local
store mutations with an exclusive directory lock and checks the owning token on
release. A dead owner can be reclaimed; a live owner is never removed by elapsed
wall time. Callbacks must not return promises. `StoreLockError` reports bounded
lock contention. The Mesh store and durable task inbox share this primitive.

## License

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
