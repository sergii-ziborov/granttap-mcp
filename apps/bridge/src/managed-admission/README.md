# Managed relay admission

`managedAdmissionOptions` obtains a fresh short-lived relay lease using the
saved account machine credential at each socket upgrade. The account service
chooses the stable computer identity and enforces Personal seats; QR rooms and
native agent sessions do not take additional seats. Own-relay connections never
call billing. Tickets are transport headers and are not prompt content.

The background monitor, MCP tool connection, desktop Task handoff, agent hooks
and machine-role Mesh connections all use this entry point. Their leases renew
on the existing socket; the provider conversation and task keys remain intact.

Missing account links and unavailable admission endpoints fail closed. An HTTP
404 or 503 never becomes a free transport grant. Every answer is kept as this
computer's [account-link state](../account-link-state/README.md): 401 (and a 403
naming the computer revoked) is `revoked`, any other 403 is `seat_limit` or
`no_subscription`, no answer is `unreachable`. A refusal because of the account
throws `AccountAdmissionError` with that state and a sentence that says how to
sign in again (`granttap sign-in`, or Sign in again on the card); the relay
client reports it to its link watch and logs it once per ten minutes
(`[relay] admission refused: …`), and the monitor does not restart for it. Official TestFlight access is
issued by the account service from verified beta evidence. Commercial relay mode
also requires a valid signed lease independently of the client.
Expiry/refund stops hosted delivery; local provider approval remains available,
and history, pairing keys and pending decisions are retained.

Copyright (c) 2026 Sergii Ziborov. Licensed under the GrantTap Commercial Source License in the repository root.
