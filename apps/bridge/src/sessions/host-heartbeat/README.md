# Host heartbeat presentation

Public entry: `heartbeatDisplayText` in `index.ts`. Complete host heartbeat
instructions and quiet `DONT_NOTIFY` responses do not appear as human messages,
conversation titles or status previews. `NOTIFY` responses retain their message
text and Markdown. Native files and IDs are unchanged. Projection happens before
the live transcript's text limit is applied.

Unknown fields, decisions, malformed XML, quoted examples and ordinary messages
remain visible. XML text accepts only the predefined entities and valid numeric
character references; it never resolves external resources.

Behavioral tests live in `tests/`. License: GrantTap Commercial Source License in
the repository-root `LICENSE`.
