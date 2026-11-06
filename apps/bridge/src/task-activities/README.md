# Task activities

The public entry point is `index.ts`. A leader publishes an encrypted preview of
its existing root catalog to a phone-created Live Activity. It never scans a
provider or treats an idle execution as a completed Task. Project/Task identities
deduplicate executions; provider children remain inside their root conversation.

The phone enrolls an independent, expiring preview key encrypted to this computer.
Every publish revalidates its controller and activity scope. The relay receives
only ciphertext, opaque identities and delivery metadata. Privacy mode excludes
computer names and task text before encryption. Catalog freshness, not delivery
time, determines when the card becomes stale.

HTTP delivery has its own bounded, single-flight lane. An unavailable APNs route
does not block relay heartbeats or ordinary task delivery. Updates are coalesced
and the system may further limit Live Activity refreshes. Existing clients keep
their ordinary notifications.

This source is covered by the GrantTap Commercial Source License in `LICENSE.md`.
Third-party dependencies retain their own licenses and notices.
