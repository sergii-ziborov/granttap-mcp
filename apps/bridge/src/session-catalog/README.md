# Session catalog

`index.ts` keeps the native identities of the latest published catalog. Requests
for a chat already shown on the phone use that identity instead of walking every
provider directory again. A new discovery window cannot make a known chat
unreadable merely because hundreds of newer logs appeared.

The private `session-catalog-cache.json` contains metadata and validated native
source locations. It excludes messages, capability descriptions, and credentials.
The room and provider roots bind its scope. On restart the primary monitor sends
the saved Now chats' current native heads under their independent task keys before
performing an expensive fresh discovery scan. It does not republish an old catalog
as fresh. The phone continues its durable historical backfill independently.

Tests live in `tests/`. This runtime module uses the repository MIT License.
