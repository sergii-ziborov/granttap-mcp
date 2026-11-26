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

When this computer cannot admit the phone, `refusal.ts` tells it why instead of
leaving it to time out. In place of the offer the poller posts, once per request,
a refusal sealed exactly as an offer is (`{senderPublicKey, nonce, box}` to the
request's phone key, under the phone's 8192-byte limit):

```json
{ "schema": "granttap.account-refusal.v1", "requestId": "…", "machineId": "…",
  "reason": "phone_limit", "phones": 17 }
```

`reason` is `phone_limit` (every place is held by a phone used in the last day,
the first pairing or an open QR; `phones` is how many this computer accepts),
`pairing_incomplete` (a pairing file without its parked phone half), or
`unavailable` (any other local failure). No refusal is sent for a request that
is malformed or expired, for a pairing lock another process holds, or when the
account server cannot be reached: those keep their sealed answer and are tried
again on the next poll. A phone that only knows offers fails to open a refusal
and gives up. Each request that cannot be answered writes one helper-log line,
`[account] could not answer a phone's account sign-in: <reason>`, ending in
`(telling the phone: <reason>)` when a refusal goes out, whatever the number of
polls.

The normal QR pairing path remains independent. A passkey authenticates the
account; an ephemeral phone public key encrypts the pairing offer end to end.

This runtime module is covered by the repository GrantTap Commercial Source License.
