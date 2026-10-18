# Engine distribution

`index.ts` owns setup-time installation of the commercial Engine. Release
metadata is reviewed with the MCP source and pins the exact platform, size and
SHA-256. Downloads use the fixed GrantTap HTTPS origin, no redirects or cookies,
a deadline and a streaming byte limit. A download cannot choose its own hash.

Verified executables live in versioned private directories. New bytes are
written and synced to an exclusive temporary file before an atomic rename.
Failed downloads leave the previous declared Engine untouched. Setup saves the
new declaration only after verification; service restart loads it normally.
Custom executable declarations remain available through `setup --engine`.

Provider hooks never download an executable. The catalog can connect and replay
questions independently of Engine installation and repository analysis.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
