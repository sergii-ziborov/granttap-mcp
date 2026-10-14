# Claude questions

Public entry point: `index.ts`. Handles Claude Code `AskUserQuestion` through the
existing encrypted, durable approval channel. All original questions, options,
descriptions, multiple selections and custom answers stay attached to the exact
native chat and call. A permission Allow without complete answers is rejected.
Auto allow never invents an answer. Transport timeout leaves Claude's local
question UI available. Successful answers return the original `questions` and
an `answers` mapping using Claude's documented PreToolUse `updatedInput` contract.

Tests: `tests/`. Engineering contract: the Apple repository `AGENTS.md`.

License: Apache License 2.0; see the repository LICENSE.
