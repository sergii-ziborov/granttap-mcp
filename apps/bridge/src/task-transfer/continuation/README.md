# Transfer continuation

Public entry: `index.ts`. The computer persists the current transfer receipt for
the source chat. Continuing that source requires explicit consent for the same
Project, Task and receipt hash. A stale acknowledgement cannot reopen a later
transfer. Consent permits both branches and does not pause the destination.

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
