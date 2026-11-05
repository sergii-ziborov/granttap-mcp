# Native task origins

Public entry: `index.ts`. The receiver records the authenticated controller,
room and original message before starting a native task. A completed native
creation supplies the session ID. A continuation never supplies or invents it.

Private records contain a request digest and routing metadata, never prompt
text or attachments. Atomic, flushed writes and a process lock preserve the
mapping across restarts. An interrupted owner, corrupt record, changed request
or missing native ID cannot authorize another new task.

Tests live in `tests/`. Origin lookup does not bypass normal provider, pause,
Project or controller authorization.

Only clients that opt into origin registration change creation behavior.
Transport timestamps and retries keep one origin. A definite failure can be
retried with a new explicit controller retry generation; an interrupted or
unknown native attempt requires confirmation instead of automatic replay.

## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
