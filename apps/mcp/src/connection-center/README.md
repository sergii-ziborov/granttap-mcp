# Connection center

`../mcp-tools/connect` registers the public `connection_status`, `connect`,
and confirmed `reconnect` tools. `state.ts` owns the process-local pending QR
and sanitized connection snapshot. `../mcp-tools/connect/widget.ts` serves the card in `card/` as one
self-contained MCP Apps resource (`ui://granttap/connection/v7.html`): `widget.html` with `card.css` and the
scripts `bridge.js`, `phones.js`, `phones-view.js`, `account.js` and `view.js` inlined, in that order
(`CARD_SCRIPTS`).

## The card

From the top: the status line (Connected · iPhone is active now, Paired · last phone activity 3 h ago, Not
paired, a QR waiting or expired, or, on GrantTap's relay, Signed out of GrantTap · phones cannot reach this
computer) with Refresh; the account callout whenever the sign-in is not ok; the QR panel when there is one to
show; **This computer**: its name, the GrantTap MCP version and a newer one waiting (in a line of the card's
own, the server's sentence as its tooltip), the Automatic updates switch and the GrantTap account line;
**Phones**; **Pairing**: Add another
phone and Reconnect a phone (each confirmed in place) and how to unpair this computer, which only
`granttap reset` in Terminal does; then connection details and help.

**Phones** (`phones.js` holds the rules, `phones-view.js` the rows) follows the phone app's Devices → a
computer → Phones: one row per phone with its name, or `Phone <label>` / `First pairing`, **Active now** for
a phone heard from in the last minute or **Last active** for the one heard from most recently, and Last seen
… or Never seen (· added … when known). The list is sorted most recent first; from eight phones it shows five
and **Show all N phones**. A callout above it says how many phones were not seen for 30 days, from the
server's `stale` mark, with **Remove N**. Each row has **Remove**, except when only one phone is paired. Both
confirm in place (Cancel focused, Escape cancels) and then call `remove_phones` (`phoneIds: [id]` or
`notSeenForDays: 30`) through the same bridge, which asks for a yes on a phone: the confirmation says so, and
for the phone heard from most recently that the phone that answers stays. While the phone is asked (up to
about three minutes; the card waits 200 s) the confirmation's buttons give way to a line of the same height,
which takes focus, and nothing else starts. The answer is shown at the row, or under the list for a removal,
and announced; a refusal shows the server's reason in words for a person; if the host gives up waiting, the
card says a yes may still have removed it. The list is then read again with `connection_status`.

The card follows the host's MCP Apps `hostContext` theme and style variables (only `--` custom properties,
one by one), at initialization and on `ui/notifications/host-context-changed`, with its own light and dark
fallbacks. It reports its content's own height, so it shrinks after a removal.

Opening the center does not create keys, start a relay connection, or install
hooks. Connect preserves an existing machine identity, including when the local
phone export is absent. Reconnect requires explicit confirmation. A pending QR
is reusable until expiry in this MCP process; restarting the process loses the
transfer code but preserves the pairing. It never persists transfer secrets.

Status also carries, read without writing: `accountLink` (`state`, `reason`, `checkedAt` and `answeredBy`,
the GrantTap process answering phones signing in with the account; `../status/account-status.ts`), with
`accountLinkSaved` kept for older readers and true only while the sign-in is ok; a summary sorting the paired phones by when each
last reached this computer, then one line per phone with its label and last-seen time, and how many
were not seen for 30 days, the cue for `remove_phones` (keys stay paired until someone removes them, so
old test installs stay listed). Each structured phone carries `id`, `label`, `primary`, `addedAt`, `mostRecent`
(the phone heard from most recently) and `stale` (idle 30 days and not `mostRecent`: what `remove_phones` with
`notSeenForDays: 30` takes). A phone that never reported a name is `Phone <label>`, or `First pairing`, as the
phone app names it. Also `pendingUpdate`, a newer runtime this computer holds and why it is not running yet;
and `chat`, for the chat named in this server's environment (Claude Code's
`CLAUDE_CODE_SESSION_ID`), the phone messages queued to reach it after its turn and whether it
continues by itself after a subscription limit. Hosts that name no chat get `chat: null`; none is
guessed. `../status/chat-status.ts` assembles the chat part.

Saved keys, this process's relay socket, and recent authenticated phone messages
are distinct. Unknown phone availability stays unknown. Provider readiness is
configuration information, not evidence that the provider is currently running.
A phone observation does not clear a pending QR. Enrollment completes only when
a new endpoint identity is adopted. Expired QR images and copy actions are
removed; Create a new QR or confirmed reconnect can issue a replacement.

The UI initializes the MCP Apps bridge before invoking tools, bounds waits,
checks parent messages, refreshes pending pairing while visible, and keeps
copyable transfer material out of model-visible text and persistent UI storage.
Non-UI clients can still use the tools and display the returned QR image.

**The account callout** (`account.js`) reads `accountLink` and holds the card's only Sign in button:
`none` shows **Sign in** (titled "This computer is not signed in" on GrantTap's relay, where phones cannot
reach it without one), `revoked` shows "Signed out of GrantTap" with the server's reason and **Sign in
again**, `unreachable` says the account service is not answering since when, with **Sign in again** for when
it lasts. `seat_limit` and `no_subscription` are plain text, no button: "This computer is not covered by your
subscription", what to change, and a **Managed computers** link (granttap.com/account#managed-computers).
`ok` hides the callout; the account line says Signed in, or checking while no answer came yet. An older
server's `accountLinkSaved` alone reads as ok or none. On an unpaired computer that is signed in, the pairing
panel says to open GrantTap on the iPhone signed in to the same account and its button is **Show a QR
instead** (`reconnect`); not signed in, **Add a phone** calls `connect`, which returns the sign-in page and
the QR.

Sign in calls `sign_in` (`passkey.ts`): a short-lived, authenticated website request. A fresh passkey
assertion on granttap.com signs this computer in to the user's account; the site returns a machine token
only to the local MCP watcher, which saves it privately, checks it once (`verifyAccountLink`) and, after
the page moved on, tells `onAccountSignedIn` listeners (the tool process restarts its relay link). The QR
pairing room and provider runtime remain unchanged. The callout links only a
`https://granttap.com/connect#request=<uuid>` page, read from structured tool output when a host omits
MCP metadata. The separate coding-app OAuth page can also use passkey to authorize that MCP client, which
signs this computer in too. The Codex-owned plugin management page is not this card.

The Automatic updates switch calls `set_runtime_auto_update` with an explicit
boolean and displays the confirmed persisted result from the server. The setting
is computer-wide for the GrantTap runtime; marketplace plugin updates stay under
the coding app's control. A service environment override locks it off. Failed
saves do not optimistically change the switch. Pairing and capability policy are
stored separately and preserved.

`granttap sign-in` (`../bin/sign-in.ts`, logic in `../bin/sign-in-command.ts`) starts the same page, opens
it on macOS from a terminal, waits for the sign-in, checks it and says what is next.

Tests in `tests/` exercise isolated keys, a loopback encrypted phone connection,
expiry, non-mutating status, and actual DOM button/host-message behavior; `tests/phones-card.test.ts` covers
the phone rules and the Phones section (rows, collapse, the 30-day action, confirmation, waiting, each
answer, focus, theme).

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
