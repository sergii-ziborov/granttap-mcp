# Session catalog

`index.ts` keeps the native identities of the latest published catalog. Requests
for a chat already shown on the phone use that identity instead of walking every
provider directory again, including image chunk requests. The in-memory catalog
retains current names; the private restart cache contains only native identity. A new discovery window cannot make a known chat
unreadable merely because hundreds of newer logs appeared.

The private `session-catalog-cache.json` contains metadata and validated native
source locations. It excludes messages, capability descriptions, and credentials.
The room and provider roots bind its scope. On restart the primary monitor sends
a fresh live catalog first, then resumes the saved Now chats' native heads under
their independent task keys in the background. Closed-history discovery runs
separately from that first live publication. It does not republish an old catalog
as fresh. The phone continues its durable historical backfill independently.

Tests live in `tests/`. This runtime module uses the repository GrantTap Commercial Source License.

Engine binding recovery waits for the first connected catalog publication before projecting repository graphs. A cold Engine cannot hold the initial relay handshake behind restored Mesh analysis.

Codex and Claude discovery share repeated checkout verification only within one scan. The next scan verifies repository identity again; no long-lived checkout cache can cross a repository change. This keeps startup catalog delivery ahead of repeated Git subprocesses.

Subscribed transcript heads use a separate, single-flight transfer loop. A stalled head never occupies the current catalog publication slot; stopping the monitor cancels further queued reads. The iPhone keeps its historical backfill independent of both loops.

Authenticated subscription and transcript requests pass the verified requester key to the encrypted reply. A requested page does not wait for copies addressed to other paired controllers. Shared catalogue and chat updates remain available to passive controllers.

Periodic native discovery yields between source files. The same provider parsers
and metadata caches serve synchronous CLI readers and cooperative live-monitor
readers. Checkout observations are scoped to one asynchronous scan, so unrelated
requests cannot inherit an old directory result. Socket recovery immediately
republishes the current catalog instead of waiting for the next periodic tick.
