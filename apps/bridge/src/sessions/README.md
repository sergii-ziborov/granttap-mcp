# Native session catalog and activity

Public entry: `index.ts`. Provider readers discover local executions and keep
their native source identity for explicit chat and nested-conversation requests.
`session-activity.ts` owns provider selection and bounded child replies.

Claude child reads use only the requested owned log and its bounded recent
window. Native `agentId` remains authoritative when it differs from the filename;
the scanner records that mapping. Parent and sibling logs are not reparsed for
each child request. Old records outside that recent window are not included in
the child snapshot. Root chat pagination remains in `TranscriptHistory`.

Feature tests live in `tests/`; the reusable multi-provider conversation harness
lives in the repository `tests/thread/` directory.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
