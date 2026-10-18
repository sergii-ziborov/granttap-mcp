# Monitor Engine preparation

`index.ts` repairs an absent or outdated managed Engine from the pinned release
before background graph recovery. It preserves custom executable declarations,
explicit disablement and policy settings. A declaration changed while a download
is in flight cannot be overwritten. Provider hooks never invoke this module.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
