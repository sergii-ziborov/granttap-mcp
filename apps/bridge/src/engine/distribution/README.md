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

Setup never aborts because an Engine cannot be prepared. `prepareSetupEngine`
reports why: no pinned release for this platform, an unavailable or
unreachable download, or a configured executable that disappeared. It then
keeps a previously declared Engine only while its bytes match the saved
checksum, otherwise declares the first usable standard location. With neither,
setup reports Graph as unavailable and completes its remaining steps. An
explicit `--engine` executable is never replaced by another one.

Provider hooks never download an executable. The catalog can connect and replay
questions independently of Engine installation and repository analysis.
The monitor prepares a missing or outdated managed Engine in the background,
retries failed downloads and recovers verified bindings once it becomes healthy.
When an update cannot be downloaded, a declared Engine that still verifies stays
in use until the helper next starts. A platform with no pinned release and no
declared Engine leaves Graph unavailable without a retry loop.
Explicit disablement and custom executable declarations remain in force.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
