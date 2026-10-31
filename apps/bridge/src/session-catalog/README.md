# Session catalog

`index.ts` keeps the native identities of the latest published catalog. Requests
for a chat already shown on the phone use that identity instead of walking every
provider directory again, including image chunk requests. The in-memory catalog
retains current names; the private restart cache contains only native identity. A new discovery window cannot make a known chat
unreadable merely because hundreds of newer logs appeared.

The private `session-catalog-cache.json` contains metadata and validated native
source locations. It excludes messages, capability descriptions, and credentials.
The room and provider roots bind its scope. On restart the primary monitor sends
the saved catalog with its original timestamp before starting fresh discovery,
and resumes the saved Now chats' native heads under their independent task keys
in the background. Fresh discovery replaces that saved state. Closed-history
discovery runs separately from the first live publication. The phone continues
its durable historical backfill independently.

Tests live in `tests/`. This runtime module uses the repository GrantTap Commercial Source License.

Engine binding recovery waits for the first connected catalog publication before projecting repository graphs. A cold Engine cannot hold the initial relay handshake behind restored Mesh analysis.

Codex and Claude discovery share repeated checkout verification only within one scan. The next scan verifies repository identity again; no long-lived checkout cache can cross a repository change. This keeps startup catalog delivery ahead of repeated Git subprocesses.

Subscribed transcript heads use a separate, single-flight transfer loop. A stalled head never occupies the current catalog publication slot; stopping the monitor cancels further queued reads. The iPhone keeps its historical backfill independent of both loops.

Authenticated subscription and transcript requests pass the verified requester key to the encrypted reply. A requested page does not wait for copies addressed to other paired controllers. Shared catalogue and chat updates remain available to passive controllers.

Periodic native discovery yields between small timed batches of source files.
Warm metadata-cache hits share a batch instead of waiting behind one background
Project projection for every unchanged file. The same provider parsers
and metadata caches serve synchronous CLI readers and cooperative live-monitor
readers. Checkout observations are scoped to one asynchronous scan, so unrelated
requests cannot inherit an old directory result. Socket recovery immediately
republishes the current catalog instead of waiting for the next periodic tick.

Open chats follow a separate two-second loop of known native sources.
Only changed source revisions send encrypted transcript heads; reads and sends
remain single-flight and bounded to eight chats per pass. Claude end-turn and
Codex turn events update execution state immediately after observation. The same
native observation releases queued messages without waiting for full discovery.
A fresh chat does not advance the observation clock of unrelated catalog rows.
Full discoveries recheck known native execution state immediately before sending
their catalog, so a scan started during a turn cannot restore stale Working after
an independently delivered completion. Runtime handoff also waits for owned
provider turns to settle, including work already acknowledged to the phone.

Fast open-chat heads use bounded native root pages. Closed chats and child
conversations remain on their independent refresh/request paths. A model
end-turn record describes presentation; a CLI invocation may still own background
work. Queue admission and runtime handoff keep the physical-invocation guard
until that invocation returns its result.
