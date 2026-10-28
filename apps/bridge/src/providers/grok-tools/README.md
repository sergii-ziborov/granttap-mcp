# Native Grok tools

Public entries in [`index.ts`](index.ts) normalize native `tool_calls` and legacy
`tool_use` content blocks into observed activity. JSON arguments stay structured;
malformed arguments never become raw text. Stable native call IDs prevent an
assistant sentence and its tool from sharing one activity identity. Existing
legacy activity IDs retain their original format.

`grokToolCompletions` reads bounded, incremental `events.jsonl` metadata, retaining
only call ID, tool name, outcome and timestamp. It caches at most 32 sessions and
2,048 calls per session, reading at most 8 MiB per pass. Missing, oversized,
truncated or unobserved completion evidence does not establish a successful edit.

`grokRecordedChanges` exposes a `search_replace` fragment only after successful
completion of that exact native call and tool. Failed/pending calls, sensitive
paths and replace-all operations without exact occurrence counts do not produce
claimed file changes. This reader never executes tools, repairs global hooks,
changes provider policy, sends prompts or invents nested agents.

Behavior tests live in `../../sessions/scan/tests/grok-native-tools.test.ts` and
the local `tests/` directory. The GrantTap Commercial Source License in the
repository-root `LICENSE` applies.
