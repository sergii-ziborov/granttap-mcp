# Task job HTTP client

Public entry: `index.ts`. `requestTaskJob` uses the authenticated room's opaque
queue API and returns bounded metadata receipts. Ciphertext uploads preserve the
caller's stable job identity; status requests explicitly exclude photo payloads.
Redirects are rejected. HTTP failure text never includes credentials or content.
`TaskJobHttpError.status` supports a bounded product error mapping.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.

A request that fails because the relay closed an idle pooled connection
(`UND_ERR_SOCKET`, `ECONNRESET`, …) is sent once more on a fresh connection.
Claims and outcomes carry their claim id, so the repeat is idempotent.
Tests: [`tests/dropped-connection.test.ts`](tests/dropped-connection.test.ts).
