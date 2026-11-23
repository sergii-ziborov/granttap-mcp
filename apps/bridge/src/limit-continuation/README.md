# Limit continuation

Public entry: `index.ts`. When a Claude chat's last request was refused by its subscription
window, the published session carries `usageLimit { resetsAt, window, autoContinue }`. The
persistent monitor then keeps one "continue" waiting for that chat, due a minute after the reset,
and puts it on the relay's durable task queue. The relay holds it while this computer sleeps or the
phone is away, and offers it back like any queued phone message: the chat receives it when it is idle.

## Waiting

The job is written to `limit-continuation.json` first, with the exact message, and put on the relay
after. A relay that does not answer, a monitor restarted halfway or an update that takes over leaves
the next pass the same copy, sent again unchanged until the relay confirms it (`holding.ts`,
`relay-copies.ts`). Every copy has an id of its own. The relay keeps an id it has seen, cancelled or
delivered, for a week after its expiry and refuses it for another message, so a continuation queued
again (the chat was refused again for the same reset after it went on, or turned off and on again) is
a new copy. Up to 0.8.198 the id was the chat and reset alone: a chat continued early from a weekly
limit and refused again by the same reset days later could not be queued again, and nothing said so.

Each monitor process asks the relay about the copy due at the reset when it first sees it, hourly while
it waits, and every five minutes once it is due. A copy the relay no longer holds, and has not been
delivered, is queued again under a new id. The relay keeps a job for 30 days and the copy until a week
after it is due, well past Claude's longest window of 7 days.

A continuation is taken back from the relay when the person turned it off, when another limit stops
the chat, or when the chat went on: it works, or shows activity newer than its refusal. A chat that has
not moved since it was refused keeps its continuation after Claude's catalog stops showing the limit,
an hour after the reset, so a Mac that slept through the reset continues the chat soon after it wakes.
One still waiting a week after its reset expires. A limit found more than an hour after its reset with
no continuation waiting for it was abandoned, not waited for, and is never woken by an update.

## Going early

The window often has room before the time the refusal stated. While a continuation waits, the
monitor looks at Claude's account readings (`lift.ts`). It queues one more continuation, due at once,
when a reading of the same window, taken after the continuation was queued and less than ten
minutes old, shows it below 98 % used, or ending more than five minutes before the refusal's reset
(it already rolled over). `five_hour` is read from the five-hour window, `seven_day` from the weekly
one, and a weekly limit named after one model (`seven_day_<model>`) from that model's weekly limit
when exactly one reading names it. `seven_day_overage_included`, other kinds, a signed-out account
and missing readings never go early. The early continuation is tried once per chat and reset time.

## Delivery

Only the copy the chat's job holds now is delivered, while the phone has not turned it off and the
newest catalog does not show the chat gone on since its refusal; anything else the relay offers is
refused. A delivered copy is recorded before the chat gets it. A chat its reset refuses once more after
it was continued waits a quarter of an hour for the next continuation.

Only Claude chats are continued. A Codex chat stopped by its usage limit carries `usageLimit
{ resetsAt, autoContinue: false }` (`resetsAt` from Codex's "try again at …"), so the phone says
"Limit reached" and when it resets; nothing is queued for it. The phone turns it off or on per chat
with `session.autocontinue.set`. It is on by default.

The monitor log has one line each time a continuation is queued, queued again, delivered, skipped or
taken back (with why), or expires, naming the chat by the start of its id and never its words
(`log.ts`). A state the disk cannot read stops the pass with one line and is never replaced unseen.

`limitContinuationFor` reads one chat's setting and waiting continuation for that chat's own MCP
status. Tests live in `tests/`; `relay-fixture.ts` keeps the relay's rules for job ids.

License: GrantTap Commercial Source License; see the repository LICENSE.
