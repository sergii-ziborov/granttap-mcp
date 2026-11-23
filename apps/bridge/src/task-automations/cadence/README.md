# Automation cadence

Public entry: `index.ts` (`scheduleProblem`, `nextOccurrence`, `lastOccurrence`,
`occurrencesBetween`). Pure functions of a schedule and a time: no timer, no state, no delivery.

- `once` runs at its time and then has no next run.
- `hours` runs every N hours counted from its anchor, the moment it was saved, edited or resumed;
  elapsed hours, so a daylight-saving change does not move it.
- `daily` runs at a wall-clock time on the chosen weekdays, every day when none are chosen.
- `cron` takes five fields (minute, hour, day of month, month, weekday) of numbers, `*`, ranges,
  steps and comma lists; month and weekday names (`JAN`, `MON`) and 7 for Sunday are accepted. As in
  Vixie cron, a restricted day of month and a restricted weekday match on either one.

Wall-clock schedules use the computer's time zone and keep their time of day through daylight-saving
changes; a time a change skips runs at the time the clock shows instead (02:30 becomes 03:30).
`daily` is evaluated as the cron set it describes (`cron.ts`). Tests: `../tests/cadence.test.ts`.

First-party code is under the GrantTap Commercial Source License.
