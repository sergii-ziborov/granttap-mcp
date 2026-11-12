# Limit continuation

Public entry: `index.ts`. When a Claude chat's last request was refused by its subscription
window, the published session carries `usageLimit { resetsAt, window, autoContinue }`. The
persistent monitor then queues one "continue" for that chat on the relay's durable task queue,
due a minute after the reset. The relay holds it while this computer sleeps or the phone is away,
and offers it back like any queued phone message: the chat receives it when it is idle.

The phone turns it off or on per chat with `session.autocontinue.set`. It is on by default.
Turning it off takes the queued copy back from the relay. A copy the relay still offers afterwards
is refused at delivery. The same happens when the chat went on by itself first. A limit that reset
more than an hour ago is treated as abandoned and is never woken by an update.

State lives in `limit-continuation.json` in the private config directory. Tests live in `tests/`.

License: GrantTap Commercial Source License; see the repository LICENSE.
