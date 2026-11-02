# Claude open questions

Public entry: `index.ts`. A Claude chat that stopped to wait for the person keeps
its question on paired phones until it is answered, however long that takes.
Two native shapes count: the desktop app's end-of-turn ask (`mcp__ccd_turn__wrap_up`
with `ask`) and an `AskUserQuestion` the hook handed to the phone after its
window passed (see `claude-questions`). Tool approvals stay quick: they live only
while the hook waits.

The question travels as an ordinary GrantTap question card. Reply buttons become
trailing `• ` choices; desktop app actions (commit, merge…) are left out because
only the desktop app runs them. The answer is an ordinary message to that chat,
so current provider, pause, Task policy, the queue and receipts all apply.

A later message from the person closes the card on every device: typed at the
computer, a desktop button, or the phone reply itself. A newer question replaces
an older one. Records survive monitor restart and are replayed when a phone
reconnects or refreshes; repeat scans do not notify again. A question first seen
more than an hour after it was asked arrives without a wake notification. After
seven days a card expires without claiming that it was answered.

Reads cost one stat for an unchanged chat. A changed one is read from its last
megabyte, and only small rows that can matter are parsed. Working chats are read
only to close a card they left open. History is included, because a chat can wait
long after it leaves the live list. Native transcripts are never modified.

Tests under `tests/` cover publication, replacement, desk answers, the deferred
`AskUserQuestion`, replies, quiet late discovery and expiry.

License: GrantTap Commercial Source License in the repository-root `LICENSE`.
