# Account recovery

`link.ts` persists the local Mac's opt-in account machine credential in its
private GrantTap config directory. The Mac app can enroll through its existing
authorized loopback connection; the provider MCP consent flow can enroll after
a verified passkey assertion. `phone-link.ts` accepts a legacy QR room's
machine-scoped credential only when it matches the Mac's existing account
machine, or when the Mac has no account machine yet. It cannot revoke or
replace a machine enrolled through passkey. The Mac verifies the credential
against the account service before saving and never receives the phone's
account session token. The credential lets
`poller.ts` answer
short-lived, account-authorized phone requests. `offer.ts` creates a new phone
controller key in the current room and seals its pairing half to the phone's
ephemeral public key. The website stores only the machine token hash and sealed
offer; it never receives a pairing key in plaintext.

The normal QR pairing path remains independent. A passkey authenticates the
account; an ephemeral phone public key encrypts the pairing offer end to end.

This runtime module is covered by the repository MIT License.
