# Runs another chat started, in the catalog

Public entry: [`index.ts`](index.ts). Part of the [session catalog](../README.md); the links themselves
come from [started-by](../../started-by/README.md).

A chat that starts hundreds of short headless runs (`codex exec` per picture) does not get hundreds of
catalog rows. Among the finished runs one listed chat started, the newest three stay rows; the parent
carries `startedChildren { finished, stopped, limited, pictures, lastAt }`. Running children and
children whose parent is not listed stay rows, and the full catalog still finds every child for a
phone that opens it or a message for it. Finished children are not refreshed as bulk transcript heads
either; an open one still is. With 600 finished runs a catalog went from 635 rows (about 0.3 MB, sealed
per phone each refresh) to 38 rows under 20 KB (`tests/compaction.test.ts`).

**Every run, not the window's** (`ledger.ts`). The catalog reads each provider's newest 200
transcripts. A course chat on 17 November 2026 started 909 Codex runs in a day; the parent counted
the newest 200 alone ("200 of 200 stopped"). Each finished run a catalog sees is now written down
under the chat that started it, once: how it ended (answered; stopped by a usage or rate limit, as
the phone reads a limit; stopped on another error), whether it saved a picture, and when. The counts
on the parent are those of every run written down, together with the listed ones: `finished` all of
them, `stopped` every stop, `limited` the limit stops among them, `pictures` those with a picture. The
newest rows are counted too. `started-runs.json` in the config folder keeps ids, an outcome letter and
a time, at most 20,000 runs over six months, the oldest let go first; no folder or request.

**Past the window** (`beyond-window.ts`). Runs that left the window before a catalog saw them
finished, or before this runtime ran, are read at most once a minute by the leading monitor after it
publishes a catalog: the up to 2,000 Codex rollouts just past the window, no more than two days old
(older ones cannot be linked from a transcript any more), skipping by file name those written down
and reading again only a changed file. Each headless one is linked by the catalog's own rules against
the chats the last catalog read that ran commands, and written down. On the course's 909 runs the
first pass read 709 rollouts in about 2 s; later passes read none.

**The ids, for the phone** (`publish.ts`). A phone keeps what it was once sent: an older catalog's row
of a run, made before runs named their parent, and the Mesh Task an older runtime made for it. A count
does not say which of those are runs. For each listed parent with runs, the monitor sends
`sessions.children { parent, children, total }`: every run written down and every link, newest first,
at most 4,000 ids. It is sent once, again when the list changes (at most once a minute while a script
still starts runs), and every quarter hour for a phone that was away; nothing in between. The course
parent's list is 909 ids in 35.6 KB, against a 200 KB catalog sent every 30 s.

**Drawn when asked** (`monitor/history/pages.ts`). The phone counts the rest under the chat ("12 earlier
runs"); a tap asks for them with `sessions.history.query { startedBy: [chat ids] }`. The answer is a history
page of only the runs those chats started, and the runs those started in turn, newest first, 20 at a time,
read from the catalog's own window: a run older than that stays counted, and a tap never makes the
computer read every transcript it has. The phone draws them as cards beneath the chat (GrantTap 315 on).
The window is read cooperatively (`scanSessionHistoryForPagingCooperatively`), sharing a read the
catalog loop has running: read at once, a cold window held the monitor for 50 s on a computer with
large Claude transcripts, and the phone, which waited 15 s then, showed nothing.

Tests: `tests/ledger.test.ts` (outcomes, rewrites, caps, unreadable and unwritable files),
`tests/beyond-window.test.ts` (a course of 230 runs, 30 past the window: linked, counted once, a run
past two days, a person's chat and another folder left alone), `tests/publish.test.ts` (what is sent,
when, its size and bounds), `tests/compaction.test.ts`.

This runtime module uses the repository GrantTap Commercial Source License.
