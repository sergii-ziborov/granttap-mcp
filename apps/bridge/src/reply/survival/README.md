# Runs that outlive their monitor

A phone message counts as delivered once the provider took it (`monitor/message-delivery/acceptance.ts`);
its answer is owed when the turn ends, which can be hours later. A runtime update used to wait for every
such turn, so a computer whose phone chats kept running never updated. A chat's run now keeps going
through a monitor restart, and the next monitor delivers its answer.

## How a run survives

`runProcess` (`../process`) is given a parser for the run's output (`claude`, `claude-new`, `codex`,
`grok`). On macOS and Linux the run then gets a folder of its own, `<config>/runs/<runId>/`:

- `stdout` and `stderr` are files, not pipes. A pipe closes with the monitor holding its other end and
  the provider then fails writing to it; a file outlives the monitor. The monitor reads both files every
  100 ms for what it read from the pipes before: Grok's admission, a sign-in failure, the answer.
- `stdin` holds Codex's prompt and is unlinked as soon as the process has it open.
- `run.json` (`records.ts`) records the run: pid and the process's start time (so a reused pid is never
  taken for it), the monitor that started it, the chat key it holds, its deadline, how to read its
  output, whether the provider took the prompt (`admitted`) and the message counts as delivered (`late`),
  and the delivery's continuation: plain data saying how its answer reaches the phone
  (`monitor/message-delivery/late-results.ts`: `chat-reply` for a message to a chat, `new-task` for one
  that starts a task). The provider process leads its own process group (`detached`), so a monitor
  exiting does not take it along.

A run is **survivable** once it has a record, its provider took the prompt, its message is past the
acceptance window and it has a continuation. Until then it is ordinary work that holds an update back.

## Handing over

`hasBlockingDeliveries` / `blockingDeliveries` (`../in-flight.ts`) leave out a chat key whose only work is
one survivable run; `lateRunsSettling` leaves out an owed answer whose run is survivable. So the update
check (`monitor/support/runtime.ts`) no longer waits for those turns.

When the drain tells the launcher to replace the monitor (`UpdateDrain.handoff` → `freezeSurvivingRuns`),
and whenever the monitor is stopped, a survivable run that ends records its exit status and leaves its
answer on disk; this monitor reports it as `handed-over` and sends nothing for it, and the chat's key is
free. If the replacement does not come within the handoff limit, `thawSurvivingRuns` sends those answers
from here after all.

## Taking over

On start, before the task queue starts any message, the monitor calls `adoptSurvivingRuns`
(`adoption.ts`), and looks again every five seconds. A record whose monitor process is gone is adopted:

- the run holds its chat key (`holdKey`), so the chat's next message waits for it as before, and the
  catalog shows the chat working;
- a pause from the phone, a restart and the provider's request count reach it through a pid-only stand-in;
- its deadline still applies;
- when its process is gone, its answer is read from its files (`answers.ts`) and sent through its
  continuation once the relay is connected; the record is taken by renaming it, so the answer is sent once.

Without the old monitor's exit status, an answer counts only when the provider reported the end of its
turn (Claude's final JSON, Codex's `turn.completed`/`turn.failed`, Grok's `result`/`error`); otherwise the
chat is told the run stopped before it finished, while GrantTap was restarting. A run that ended while no
monitor ran is delivered the same way. A record whose monitor is still alive (a second monitor) is left
to it. A run without a continuation (a resume prompt, a moved Task's turn) is still held and watched, so
its chat is not resumed twice, but its outcome is not sent.

## What still holds an update back

Work that cannot be handed over keeps the drain's bounds (`../../runtime-updates/README.md`): a moved
Task's turn (its transfer record is updated by the monitor that started it), a Cursor conversation (a
live connection to the agent), a Codex desktop delivery in progress, a phone message waiting in memory
behind a running turn of its chat, a pending approval or provider sign-in, a maintenance action, and an
answer being sent. Windows keeps pipes and does not hand runs over. `GRANTTAP_RUN_SURVIVAL=0` on the
service turns handing over off. A run that cannot be handed over stops holding the update once its process is gone or it
showed no sign of work for thirty minutes (`../run-watch.ts`).

Tests: `tests/adoption.test.ts` (a run left by a monitor that exited is taken over, delivered once,
paused, cut off at its deadline; a run that ended while no monitor ran; a live monitor's run is left
alone; an answer frozen during a handoff), `../../../../../tests/monitor/lifecycle/update-switch.test.ts`
(an update takes over while a chat's turn runs, and the new runtime delivers its answer).

License: [GrantTap Commercial Source License](../../../../../LICENSE).
