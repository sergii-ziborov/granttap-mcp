# Ciphertext recipient routing

`publicKeyIdentifier` identifies the recipient of one encrypted envelope without
exposing content or private keys. RelayClient negotiates this optional routing
with the relay; unsupported older/self-hosted relays retain the original wire.
A controller advertises its own key digest during the authenticated upgrade.
The relay filters live and retained ciphertext for that recipient; each client
still authenticates the complete encrypted payload independently. Test coverage
lives in `tests/`. This module uses the repository GrantTap Commercial Source License.
