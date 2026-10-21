# Native capability history

`index.ts` reads Codex's local history projection through a bounded worker.
Native MCP execution records provide call identity, outcome, and duration even
when the call happened through Code Mode and the transcript preview omits it.
The database is opened read only. Native projection watermarks and the provider's
updated-page index restrict warm reads to changed calls; a completion replaces
its original call rather than adding another one. Queries run in a worker with
a bounded deadline and never occupy the relay event loop. Missing or incompatible projections remain
unknown; the existing transcript reader remains a compatibility fallback.

Only requested executions and their recorded children are queried. The worker
returns metadata, never prompts, arguments, or tool results. Its thirty-day,
20,000-record bound and per-result size bound make summaries observed evidence,
not a claim of complete lifetime usage. The recent-call list and execution
summaries are bounded independently. File paths follow the configured Codex
root and contain no machine-specific fallback.

Tests use a real SQLite history projection and reopen it after the writer closes.
This module uses the repository GrantTap Commercial Source License.
