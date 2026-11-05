# Cursor Sessions

This module owns Cursor composer catalog discovery, transcript indexing and
summaries, visible activity, and capability observations. `../cursor.ts` is the
public entry point. Characterization coverage lives in `tests/sessions.test.ts`,
`tests/agentic-sessions.test.ts`, and the provider capability suites.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.

`attention/` supplements JSONL messages with the native composer's visible
question cards and warnings. Missing hooks or a text-only transcript must not
hide the prompt or choices. Native storage is read-only and bounded.
