# Native session catalog and activity

Public entry: `index.ts`. Provider readers discover local executions and keep
their native source identity for explicit chat and nested-conversation requests.
`session-activity.ts` owns provider selection and bounded child replies.
`catalog.ts` owns provider selection and bounded live/history catalogs. The
monitor uses cooperative Codex and Claude readers, yielding between timed batches
so discovery cannot monopolize relay callbacks. Synchronous CLI readers use the
same parsers. Published native bindings stay readable until a complete scan
replaces them; checkout verification caches belong to one scan across its yields.

Claude root records update the current working folder and branch as the native
conversation moves. Its launch directory is not a permanent repository binding.
Sidechain folders and tool observations cannot replace the root conversation's
checkout. Catalog linking verifies the current Git root while preserving the
existing Task and Project identities.

Claude child reads use only the requested owned log and its bounded recent
window. Native `agentId` remains authoritative when it differs from the filename;
the scanner records that mapping. Parent and sibling logs are not reparsed for
each child request. Old records outside that recent window are not included in
the child snapshot. Root chat pagination remains in `TranscriptHistory`.

Feature tests live in `tests/`; the reusable multi-provider conversation harness
lives in the repository `tests/thread/` directory.

## Grok Build history

Grok discovery reads the local session summaries and visible conversation history.
Both role-based records and current typed user/assistant records are supported.
Typed user records must have a valid prompt index. Environment preambles, synthetic
reminders, system messages, and hidden reasoning are excluded from the timeline.
Session continuation uses the installed Grok CLI and its existing authentication.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
