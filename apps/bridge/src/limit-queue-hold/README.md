# Queued messages behind a usage limit

Public entry: `index.ts`. Phone messages queued for a chat wait on this computer (`task-dispatch`) and go one
at a time when the chat is free. A chat refused by its subscription limit is free in that sense: its turn
ended. Up to 0.8.200 each queued message then started a run the same limit refused at once, the next one
followed, and the whole queue was spent on refusals within minutes, each shown on the phone as delivered or
failed. Now the limit holds the chat's queue (`decision.ts`):

- **Before the reset** the messages stay queued: not started, not refused, not dropped. A chat has a limit
  while its catalog row carries `usageLimit`, or a stop whose reason is `usage_limit` without a stated reset
  (Codex without "try again at").
- **After the reset**, and a minute of grace, the chat's own "continue" goes first when it continues by itself
  ([`limit-continuation`](../limit-continuation/README.md)); the messages wait behind it for at most ten
  minutes past its time, then follow it one at a time as usual. With continuing turned off, or for another
  agent, the oldest message goes first after the reset, then the rest in order.
- **Refused again** after the continuation or a message went, the chat waits a quarter of an hour from that
  refusal, or until a later reset it states, before the next try. One try at a time; nothing follows a
  refusal into the same limit. A reading does not shorten this wait: readings lag, and trusting one the
  provider contradicts would try again with every reading.
- **No stated reset**: the queue waits until an account reading taken after the refusal shows room
  (`readings.ts`: the refusing Claude window below 98 %, as for an early continuation; otherwise every window
  of the agent's account reading), or a quarter of an hour, then tries one. The Codex account reading is not
  read here, so a Codex chat tries again every quarter of an hour.
- **Before the reset with room**: a chat with no continuation waiting goes when a reading shows room; one
  with a continuation lets that continuation's own early copy go first.

Send now (`deliveryMode: immediate`), a new task and the chat's own continuation are never held. A message
cancelled from the phone while held leaves this computer at its next relay lookup, every ten minutes, and in
any case before it would start.

The worker skips a held job before it takes the chat's turn (`limitHeld` in `task-dispatch/worker`), so the
continuation is not stuck behind an older message, and asks the relay about it only every ten minutes instead of
every two seconds. The job stays staged in the inbox and queued on the relay, so a monitor restart or a runtime
update keeps it and the order. What was decided is kept in `limit-queue-hold.json`: when a message last went to
a chat whose limit still showed (so a refusal after it is a refusal again, across restarts too) and whether the
hold was announced. A chat whose turn ended without a limit is forgotten. A file the disk cannot read is logged
once and the decision is made without it; the queue still waits for the reset.

## Phone

Each listed chat whose queue a limit holds carries `queueHold { reason: "usage_limit", until }` in the catalog:
the reset, or the next try after a refusal (`annotateQueueHolds`, read only). The phone shows its queued
messages as waiting for the limit to reset, with that time, and queues what the person sends meanwhile; Send now
and cancelling still work. Older phones ignore the field and older computers never send it.

## Log

One line when a limit starts holding a chat's queue and one when it lets it go, naming the chat by the start of
its id and the limit by its kind and reset, never its words (`log.ts`):

    [monitor] Queued messages for chat 1a2b3c4d wait for its 5-hour limit (reset 2026-11-23 13:00 UTC): they go one at a time after the reset.
    [monitor] Queued messages for chat 1a2b3c4d go on after its 5-hour limit (reset 2026-11-23 13:00 UTC): its continuation went first.

Tests live in `tests/`: the rules (`decision.test.ts`), the catalog field and stored state (`catalog.test.ts`),
and the persistent monitor's queue over a fake relay with a mocked clock (`queue.test.ts`): three messages kept
through a limit and run in order after the continuation, no continuation when it is off, a second refusal
holding again, restarts, Send now and cancellation.

License: GrantTap Commercial Source License; see the repository LICENSE.
