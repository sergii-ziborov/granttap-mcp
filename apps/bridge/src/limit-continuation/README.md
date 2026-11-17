# Limit continuation

Public entry: `index.ts`. When a Claude chat's last request was refused by its subscription
window, the published session carries `usageLimit { resetsAt, window, autoContinue }`. The
persistent monitor then queues one "continue" for that chat on the relay's durable task queue,
due a minute after the reset. The relay holds it while this computer sleeps or the phone is away,
and offers it back like any queued phone message: the chat receives it when it is idle.

The window often has room before the time the refusal stated. While a continuation waits, the
monitor looks at Claude's account readings (`lift.ts`). It queues one more continuation, due at once,
when a reading of the same window, taken after the continuation was queued and less than ten
minutes old, shows it below 98 % used, or ending more than five minutes before the refusal's reset
(it already rolled over). `five_hour` is read from the five-hour window, `seven_day` from the weekly
one, and a weekly limit named after one model (`seven_day_<model>`) from that model's weekly limit
when exactly one reading names it. `seven_day_overage_included`, other kinds, a signed-out account
and missing readings never go early. The early continuation is tried once per chat and reset time.
The one due at the reset stays queued until the chat goes on; a chat refused again for the same
reset keeps it and gets no second early try.

Only Claude chats are continued. A Codex chat stopped by its usage limit carries `usageLimit
{ resetsAt, autoContinue: false }` (`resetsAt` from Codex's "try again at …"), so the phone says
"Limit reached" and when it resets; nothing is queued for it.

The phone turns it off or on per chat with `session.autocontinue.set`. It is on by default.
Turning it off takes the queued copies back from the relay. A copy the relay still offers afterwards
is refused at delivery. The same happens when the chat went on by itself first. A limit that reset
more than an hour ago is treated as abandoned and is never woken by an update.

State lives in `limit-continuation.json` in the private config directory. `limitContinuationFor`
reads one chat's setting and queued continuation for that chat's own MCP status. Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository LICENSE.
