# Task automation protocol

Public entry: `index.ts`. Encrypted messages that list and change GrantTap's own automations for a
chat's Task on one computer: a name, a message sent into the chat as a phone turn, and a schedule
(`once`, every N `hours`, `daily` at a time on chosen weekdays, or a five-field `cron`). They are
separate from Codex's native automations (`../task-schedules`), which this does not touch.

`task.automations` lists; with `action` it creates, edits, pauses, resumes, deletes or runs one
now. Edits name the `revision` the phone showed, so a change made meanwhile is refused rather than
overwritten. `task.automations.result` answers only the requesting phone with the Task's rows,
each with its next run, the run waiting for the chat (and why), and the last run or skip.

A computer that knows these messages says so with `taskAutomations: true` in `machine.heartbeat`.
Older computers ignore them and older phones never send them. An `action` whose kind this computer
does not know still gets a failure answer.

License: first-party code is under the GrantTap Commercial Source License in the repository LICENSE.
