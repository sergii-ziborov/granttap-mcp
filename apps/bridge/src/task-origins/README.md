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

## License

Licensed under the Apache License, Version 2.0 (Apache-2.0). See LICENSE and NOTICE.
