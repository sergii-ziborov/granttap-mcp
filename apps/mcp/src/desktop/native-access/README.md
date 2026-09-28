# Native Mac access

`routes.ts` exposes the existing private desktop bridge on loopback for the
sandboxed Mac App Store client. This is a desktop-only authorization grant,
separate from provider MCP OAuth. A local human consent page, same-origin POST,
one-time code and S256 PKCE are required. The callback is fixed to
`granttap://desktop-auth`; there is no user-selected redirect. Pending consent
and codes expire after five minutes. A private file stores only token hashes,
up to eight active grants, expiring after 30 days. The app keeps its token in
its device-only Keychain and never shares it with a provider.

`/desktop/invoke` requires that grant before parsing a bounded request. It can
invoke only the existing allowlisted desktop operations; inputs are still
validated by the private bridge and task/policy layers. It never grants a
provider broader MCP scope. The installer/runtime remains outside the sandbox.
Tests exercise real HTTP and Unix sockets, consent forgery rejection, PKCE,
one-use codes, expiration, restart and authenticated forwarding.

This runtime module is covered by the repository MIT License.
