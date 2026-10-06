# Native Mac access

`routes.ts` exposes the existing private desktop bridge on loopback for the
sandboxed Mac App Store client. This is a desktop-only authorization grant,
separate from provider MCP OAuth. Without a passkey account, a local human
consent page, a matching one-time consent cookie, one-time code and S256 PKCE
are required. An explicit foreign Origin is rejected; native browser sessions
may send an opaque Origin. The callback is fixed to
`granttap://desktop-auth`; there is no user-selected redirect. Pending consent
and codes expire after five minutes. A private file stores only token hashes,
up to eight active grants, expiring after 30 days. The app keeps its token in
its device-only Keychain and never shares it with a provider.

`/desktop/invoke` requires that grant before parsing a bounded request. It can
invoke only the existing allowlisted desktop operations; inputs are still
validated by the private bridge and task/policy layers. It never grants a
provider broader MCP scope. The installer/runtime remains outside the sandbox.
`/desktop/account/link` uses the same native grant, verifies the app's fresh
passkey account session with granttap.com, and stores a revocable machine
credential locally. It returns only the account and machine identifiers.
`/desktop/account/authorize` exchanges the Mac app's passkey account session
for the same scoped local grant. The relay verifies the account and existing
machine identity, or enrolls this Mac if it has not been linked. The account
session remains in the app Keychain; cross-origin browser requests cannot read
it or submit JSON to the loopback service.
Tests exercise real HTTP and Unix sockets, consent forgery rejection, PKCE,
one-use codes, expiration, restart and authenticated forwarding.

This runtime module is covered by the repository MIT License.
