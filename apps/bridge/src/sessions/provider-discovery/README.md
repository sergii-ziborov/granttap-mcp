# Native provider discovery batch

Public entry: `index.ts`. Live catalogs and history share an identical pending
native provider read on this computer. The read is scoped to provider settings,
file budget and a digest of the complete process environment. No environment
values are retained in the key or published. Completion or failure removes the
pending entry; the next refresh reads current state. Each consumer still applies
its own current Task-transfer mappings after the native read.

`tests/scan-batch.test.ts` witnesses real directory discovery and Git checkout
verification, both shared concurrent reads and a fresh subsequent scan.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
