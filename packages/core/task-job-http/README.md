# Task job HTTP client

Public entry: `index.ts`. `requestTaskJob` uses the authenticated room's opaque
queue API and returns bounded metadata receipts. Ciphertext uploads preserve the
caller's stable job identity; status requests explicitly exclude photo payloads.
Redirects are rejected. HTTP failure text never includes credentials or content.
`TaskJobHttpError.status` supports a bounded product error mapping.

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
