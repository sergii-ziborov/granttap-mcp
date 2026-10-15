# Project capacity observations

`hardware.ts` measures host CPU deltas, free memory, checkout disk capacity,
and positive NVIDIA free memory when the installed driver reports it. A first
CPU sample or an unreadable resource stays unknown.

`index.ts` builds compact Project reports. Only fresh native advertised models
prove model availability; a selected or observed model does not. Provider
policy/readiness, model availability and account usage remain separate fields.

`transport.ts` encrypts the report for one Project peer through its scoped relay
writer. Reads validate Project, endpoint, revision, recipient and expiration
before projecting routing candidates. Required executables must be reported
present. Reports expire after at most 90 seconds.

Tests live in `tests/` and cover measurement deltas, unknown GPU capacity,
freshness, scope, native model evidence and required executable availability.

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
