# Background work after a phone turn

Public entry: `index.ts`; the setting the provider runner reads is in `ceiling.ts`.

GrantTap runs a phone message to a Claude chat as `claude -p`. When the turn ends while background
agents it started still run, Claude Code keeps the process alive for them, up to its print-mode ceiling
(`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, ten minutes by default), then stops them and exits. Up to 0.8.206
every phone chat's background agents were stopped ten minutes after its turn, whether or not anyone
waited for the chat; the chat was then continued (`../../background-continuation`) and had to start the
work again.

## What happens

- Every provider process the monitor starts gets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` of two hours
  (`../process`, `providerProcessEnvironment`), the longest the chat catalog expects background work to
  run. A value already set in the computer's environment is kept. Other providers ignore it.
- While the run lives its chat is in flight, so a message from the phone waits for it. The queue asks
  (`../../task-dispatch/worker/monitor.ts`, `ready`) and `messageWaitsBehindRun` looks at the chat as the
  catalog last published it: a Claude chat whose turn has ended with background work still pending
  (`backgroundTasks`). Ten minutes after that turn ended (`lastActivityAt`), and never more than ten
  minutes after the message was first seen waiting, the run's process group is stopped (`yieldRun`).
  A message so waits no longer than when Claude Code stopped the work itself.
- A run stopped so ends `{ ok: true, text: '', delivery: 'native' }`: its turn's answer is already in the
  chat's history, nothing is reported as stopped from the phone, and no continuation is queued since a
  message waits. Claude tells that message's turn which agents did not finish. A run another monitor took
  over ends the same way (`../survival/adoption.ts`).
- A new task's first run is found through its chat (`runKeyFor` in `../in-flight.ts`); its process is
  tracked under the task's operation key.

Background commands are not bounded by the ceiling: Claude Code 2.1.330 waited for a backgrounded
`sleep 90` past a 40-second ceiling. They hold the run until they end or the phone run's own six-hour
deadline, as before.

The monitor log has one line per stop, naming the chat by the start of its id.

Tests: `tests/background-wait.test.ts`, and `../survival/tests/adoption.test.ts` for a run taken over.

License: GrantTap Commercial Source License; see the repository LICENSE.
