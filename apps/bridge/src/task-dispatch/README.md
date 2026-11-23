# Durable task receiver

Public entry: `index.ts`. `TaskDispatchInbox` preserves the complete authenticated
operation, inline images and controller identity before a relay claim. Private
files use restrictive permissions, checksums, fsync and an append-only phase
journal. A partial trailing journal write never erases the last complete state.

`worker/index.ts` waits for readiness, claims on the relay immediately before a
native submission and persists a unique attempt first. Duplicates cannot reset
the attempt. A successful native result is saved before its separate completion
request. After confirmed completion or cancellation, the receiver removes the
full operation and photos, keeping only a private, minimal idempotency receipt
until expiry plus seven days. Restarting after an ambiguous submission requires confirmation instead
of blindly replaying the prompt. Queued server cancellation wins over a stale
local offer. Scheduling does not imply that the controller phone is online.

The first time a message reaches this computer, the phone gets a `delivery.arrival`,
so it can say the message is here and waiting its turn instead of still on the relay.
That is a type of its own: earlier apps read any other receipt status as a refusal.

The native sender cancels an uploaded operation with DELETE directly, without
waiting for a metadata GET. A claim conflict is reconciled by a subsequent read.
An ambiguous upload is still reconciled using the same encrypted reservation;
neither a missing response nor a receiver claim admits a second operation.
Regression cases live in `sender/tests/cancellation.test.ts`.

Tests live in `tests/` and `worker/tests/` and use synthetic operations and private
temporary directories. This module does not grant provider or project access.

An authenticated `deliveryMode: immediate` is an explicit controller release.
It takes precedence over waiting follow-ups and skips the idle requirement only;
pause, an in-flight native submission and provider policy still win. Normal jobs
use a catalog observed within 60 seconds rather than rescanning all native logs
for every pending message on each receiver tick.

While a runtime update drains the monitor (`held`), the worker starts nothing new:
a job stays `staged` here and unclaimed on the relay, so the runtime that takes
over delivers it once. Refusals, cancellations and completions still go through. A
delivery counts as monitor work (`track`) from the moment it may start until its
handler returns, so the update never exits between a relay claim and the provider
taking the message. Regression case: `worker/tests/update-hold.test.ts`.

A chat its usage limit refused holds its queued phone messages (`limitHeld`,
[`limit-queue-hold`](../limit-queue-hold/README.md)): they stay staged here and queued on the relay until the
reset and the chat's own continuation, then go one at a time. A held job does not take its chat's turn, so the
continuation is not stuck behind an older message, and it is looked up on the relay only every ten minutes, so
a cancellation from the phone still retires it. Send now, new tasks and continuations are never held.
Regression cases: `../limit-queue-hold/tests/queue.test.ts`.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
# Busy native Grok turns

Manual release retains priority over queued follow-ups but preserves Grok's
native admission boundary. Both normal and manually released messages stay in
the durable inbox while the native execution is working or waiting for
permission. The worker checks that exact native execution before claiming the
job, refreshes its catalog while held, and starts automatically once it is idle.
This does not turn a temporary native busy state into a failed delivery or ask
the person to resend. It does not claim provider-native mid-turn Steer support.

## Messages still queued behind a delivery

When a message reaches its chat while more phone messages for that chat wait here, its prompt
carries one GrantTap line after the person's words (`queue-note.ts`), for example:

> GrantTap: 3 more messages from the phone are queued for this chat and arrive after this turn.
> Tests of what you change can run now; repository-wide checks, full test runs and publishing can
> wait for the last of them unless this message asks for those now.

`worker/queue-depth.ts` counts, when the prompt is written, the jobs staged or claimed for the same
chat; for a new task, the follow-ups written for it before its chat existed. It leaves out the
delivered job, this computer's own jobs such as a limit continuation, and messages held behind a
refusal. Every job the relay offers is staged here at once, whether its chat is free or not, so the
count covers what the relay has offered; a message scheduled more than five minutes ahead is counted
once it is offered. No line is added when nothing waits or the message is attachments alone. The
delivery's identity stays the person's text, so a retried Codex delivery is still the same one.
The transcript views remove the line (`visibleUserText`, Cursor's chat name), so the phone shows
the person's words.

Every delivery path carries the line. A message that reaches the computer directly rather than
through this queue (`monitor/message-delivery`) counts the jobs staged here for its chat, or for a
new task the follow-ups written for it (`queuedForMessage`), leaving out a queued copy of the same
message. Phone messages waiting in memory for a chat behind its running turn (`reply/in-flight.ts`,
`phoneMessagesWaiting`) are added on both paths, read when each prompt is written. A moved Task's
chat (`transfer-…`) gets the line after its whole opening prompt on the first turn, and after the
person's words on the next ones. `queuedPhoneMessages` reads the same count from another process without
writing; the chat's own MCP server reports it in `connection_status`, so an agent can look again
before a long run. Regression cases: `tests/queue-note.test.ts`, `worker/tests/queue-depth.test.ts`,
`../monitor/handlers/tests/queue-note.test.ts` and `../monitor/handlers/tests/queue-note-paths.test.ts`.

Relay queue errors are logged by `worker/failure-report.ts`. A dropped connection,
a timeout or a relay 5xx is retried on the next two-second pass and is logged only
after 30 seconds of continuing failures; storage faults are logged at once. Both
are limited to one line a minute and never include a prompt.
