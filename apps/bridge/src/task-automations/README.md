# GrantTap automations

Public entry: `index.ts` (`startTaskAutomations`, `handleTaskAutomations`). GrantTap's own
automations, for chats whose agent has none of its own: Claude Code first, and Cursor, Grok or Codex
chats alike. Each one is a name, a message and a schedule (`cadence/`). When it is due, the persistent
monitor sends the message into its chat as a phone turn, through the same `handleUserMessage` a phone
message takes. Codex's native automations are separate (`../task-schedules`) and untouched; the phone
shows both in a Codex chat and says which is which.

## Where they are kept

`task-automations.json` in the monitor's private configuration directory, written whole under its
store lock (`store.ts`), so the monitor's runs and a phone's edit in another process never overwrite
each other. A file that cannot be read, or that a newer GrantTap wrote in a format this one does not
know, is never replaced: edits are refused and runs wait, with one log line. Rows a newer GrantTap
added in a known file are kept as they are. Up to 16 automations per chat, 256 per computer, and a
Task's rows must fit one reply (`controls/changes.ts`), so the list is never cut short.

## When a run goes

Every 15 seconds, and at once after a phone changed one, the leading monitor takes one locked pass
(`runner/plan.ts`):

- A scheduled run that came due becomes the one run waiting. Runs missed while the computer slept or
  GrantTap was not running are skipped in one line; the latest of them still goes, unless it is more
  than 12 hours late. Never a burst.
- A waiting run goes only when the chat is free (`runner/readiness.ts`): listed idle in a catalog under a
  minute old, no run of this monitor in it, no background work, no phone message queued ahead of it,
  not paused from the phone, and no runtime update draining the monitor.
- It waits for usage limits, reading what the limit continuation reads: the chat's own refusal
  (`usageLimit`) holds it until a minute after the reset, and a recent account-wide reading of the agent
  at 98 % or more holds it until that window resets. A per-model limit does not hold another model's
  chat. A continuation still waiting for the chat after its limit (`../limit-continuation`) goes first.
- A run still waiting when the next one is due gives way to it (skipped, with why). A run with no later
  one (one-time, Run now) gives up after seven days and two hours.
- One run per chat per pass. A claimed run is saved as ran before it is handed over, so a monitor
  stopped halfway never sends it twice; a refusal turns it into failed, with the chat's reason.

Run now marks one run waiting; it follows the same rules and leaves the schedule as it was. Pause
removes the next run and any waiting one; resume counts every-N-hours schedules from then. Without a
relay connection the catalog goes stale and runs wait.

The monitor log has one line per run, skip or failure, naming the automation and chat by the start of
their ids and never their words (`log.ts`).

## Phone

`task.automations` (`../../../../packages/protocol/task-automations`) lists the Task's automations with
their next run, the run waiting and why, and the last run or skip; it creates, edits, pauses, resumes,
deletes and runs now (`controls/`). The chat must be one this computer published, from a paired phone;
the answer goes to that phone alone. `machine.heartbeat` says `taskAutomations: true`. An older app
asking for Codex automations in another agent's chat is told to update.

Tests: `tests/` (fake clock, isolated config directory, fake relay client).

License: GrantTap Commercial Source License; see the repository LICENSE.
