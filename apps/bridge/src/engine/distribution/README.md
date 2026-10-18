# Engine distribution

`index.ts` exposes installation of the commercial Engine. Release
metadata is reviewed with the MCP source and pins the exact platform, size and
SHA-256. Downloads use the fixed GrantTap HTTPS origin, no redirects or cookies,
a deadline and a streaming byte limit. A download cannot choose its own hash.

Verified executables live in versioned private directories. New bytes are
written and synced to an exclusive temporary file before an atomic rename.
Failed downloads leave the previous declared Engine untouched. Setup and the
paired monitor save a new declaration only after verification.
Custom executable declarations remain available through `setup --engine`.

Provider hooks never download an executable. The catalog can connect and replay
questions independently of Engine installation and repository analysis.
The monitor prepares a missing or outdated managed Engine in the background,
retries failed downloads and recovers verified bindings once it becomes healthy.
Explicit disablement and custom executable declarations remain in force.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
