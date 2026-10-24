# Project relationship projection

`projectRelationshipPeers` connects the Engine's `graph.analyze_project` to the
existing Graph refresh. Only distinct repository IDs from admitted local
Project bindings are selected, with a limit of eight. A separate Engine socket
keeps expensive analysis off the policy channel.

Explicit Graph builds refresh static contract matches. Background snapshots
read the bounded retained result for the same binding/revision key; they do not
start additional cross-repository scans. Stale or unavailable results do not
establish a missing dependency.

The existing compatibility graph shows these edges as shared contracts, with
an explicit static/runtime-unverified explanation. They never enter the
verified Backbone and never merge independent Project groups or change grants.
Full relative source evidence stays in the typed Engine response. No source
excerpts or absolute machine roots are published to the phone.
