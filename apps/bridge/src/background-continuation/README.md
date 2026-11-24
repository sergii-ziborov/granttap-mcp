# Background continuation

Public entry: `index.ts`. GrantTap runs a phone message to a Claude chat as `claude -p`. When the turn
ends while background agents or commands it started still run, Claude Code keeps the process alive for
them, but only up to its print-mode ceiling, ten minutes after the last turn by default
(`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Past it Claude stops them, writes one line to stderr and exits:

    Background tasks still running 10m after the last turn (…); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.

Nothing resumed such a chat before 0.8.205: the work stayed half done until the person wrote again, and
GrantTap's compaction, which follows an idle chat over its threshold, made it look as if compacting the
chat had dropped what it was doing. Claude tells the next turn which agents it stopped ("N background
agents didn't finish before the previous session ended"), but only once something resumes the chat.

## What happens

`detect.ts` reads that line from the run's stderr when the run ends and its answer is this monitor's to
send: a run this monitor started (`../reply/process`) or one it took over from the monitor before it
(`../reply/survival/adoption.ts`, only by the monitor that takes the run's record, so it is told once).
A run handed to the next monitor is left to that one. The chat is the run's key, or for a new task the
chat its answer started; a moved Task's turn is left to its transfer record.

The persistent monitor (`../task-dispatch/worker/monitor.ts`) then puts one message on the relay's
durable queue, due at once, as the limit continuation does (`../limit-continuation`): the relay offers it
back like a phone message, and the chat takes it when it is free. Its id starts `background-continue-`.
The agent reads why its work stopped and that long work belongs inside the turn: agents run in the
foreground (several started in one message still run in parallel), long commands waited for.

## When not

- a message from the phone already waits for the chat: it resumes the chat, and Claude tells that turn
  what it stopped;
- the chat is paused, or the person turned off on the phone that it goes on by itself
  (`session.autocontinue.set`, the same switch as after a subscription limit);
- the chat is not in this computer's catalog, or is not a Claude chat;
- it was continued three times in the last six hours: work that keeps being stopped waits for the person.

A continuation is counted before it is queued, so a relay that keeps refusing it cannot repeat it past
that limit; the queue's sender keeps a copy it could not upload and sends it again. State:
`background-continuation.json` in the GrantTap folder (`store.ts`), the times each chat was continued in
the last six hours.

The monitor log has one line per stop, naming the chat by the start of its id and never its words: the
continuation was queued, or why not.

Tests: `tests/`. The turn state that shows the agents the chat still waits on is in
`../sessions/scan/claude/turn-state`.

License: GrantTap Commercial Source License; see the repository LICENSE.
