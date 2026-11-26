---
name: granttap-connect
description: The agent connects this computer to GrantTap. Use when work needs pairing or the user asks to connect, pair, sign in, or repair.
---

# GrantTap connect

The person does not pair in chat. You connect this computer by calling tools.
This is the same on Cursor, Codex, and Claude Code.

## Chat (you)

1. Call `connection_status`. Read `accountLink.state` first.
2. Not signed in (`none`) or signed out (`revoked`), or a tool said this
   computer is signed out: call `sign_in` (or `connect`, which does the same on
   an unpaired computer). Give the person the returned `passkeyUrl`: they open
   it and confirm with their GrantTap passkey on granttap.com. The link works
   once, for 15 minutes; show it only to that person.
3. Signed in (`ok`) with no phone yet: tell them to open GrantTap on the iPhone
   signed in to the same account. It links this computer by itself; no QR.
4. Only if that phone cannot use the account: the QR is the fallback. On an
   unpaired, not-signed-in computer `connect` already put it on the card;
   otherwise call `reconnect` after the person confirms.
5. `seat_limit` or `no_subscription`: signing in again does not help. Say this
   computer is not covered by the subscription and point to GrantTap →
   Subscription or Managed computers (granttap.com/account#managed-computers).
6. If the host asks to authorize the MCP client, complete that host flow.
7. Never print a pairing URI, manual token, or QR in chat, and never ask for
   the passkey itself.

If the host cannot call tools from the connection card, tell the person to run
`granttap sign-in` in their own terminal, then open the phone. For the QR
fallback: `granttap phone add`, or `granttap phone reconnect` for the same
phone. These commands refuse redirected output so the QR cannot enter agent
logs.

A saved pairing is reused. Do not call `reconnect` unless they confirmed Add
another device or Reconnect in that host's GrantTap plugin settings.
`connect_with_passkey` is the old name of `sign_in`. `request_sign_in` is
different: it signs the person in to an outside service on the phone, not to
GrantTap.

## Settings (the person)

Codex Connected accounts lists external app accounts, not GrantTap phones.
The GrantTap connection card in the coding app shows this computer's account
sign-in, with one **Sign in again** when GrantTap signed it out, the phones,
and the one-time QR under Add a device, Add another device, or Reconnect. The
iPhone app scans it under Settings → Connections → Add a device (Scan QR).
granttap.com/connect handles the passkey sign-in and coding-app approval; it
does not generate a QR. Approving a coding app there with the passkey also
signs this computer in. All coding apps on this computer share the same
pairing room and the same sign-in.

For an interactive question, send the same complete prompt to the coding app
and GrantTap under one exact correlation. The first answer with that
correlation wins.
