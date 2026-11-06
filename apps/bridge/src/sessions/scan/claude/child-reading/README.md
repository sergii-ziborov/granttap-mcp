# Cooperative Claude child reading

`readClaudeChild` reads child metadata and capability observations in two
cooperative passes over the same native file snapshot. The final native child ID
is known before capability source IDs are built. Rows are discarded as they are
processed; a large child file is never read into one array of transcript text.
The caller retains the existing fingerprint cache and merges recorded usage.

Parent/child behavior tests live in the Claude reader's `tests/` directory. They
verify reported token totals and allow transport callbacks during a child scan.

License: [GrantTap Commercial Source License](../../../../../../../LICENSE).
