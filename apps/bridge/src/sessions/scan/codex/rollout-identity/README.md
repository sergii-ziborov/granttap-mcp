# Codex rollout identity lookup

Public entry: `index.ts`. Missing native-path lookups inspect the existing bounded
summary window, not every candidate's 16 MiB activity tail. Only the matching
rollout is opened with the activity budget. Fork ownership keeps the existing
`ownCodexLines` boundary. The cache retains at most 256 path/identity signatures,
never conversation text. Device, inode, size, modification and change times
invalidate it; a file changed during the metadata read is retried on the next
lookup. Read failures and deleted paths do not retain an identity.

Local tests cover unchanged observations, replacement with preserved timestamps,
concurrent changes, retry and bounded retention. The Codex public-reader cost
regression measures bytes actually read from a large foreign rollout, followed
by a successful full read of that rollout when it is explicitly requested.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
