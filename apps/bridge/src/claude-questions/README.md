# Claude questions

Public entry point: `index.ts`. Handles Claude Code `AskUserQuestion` through the
existing encrypted, durable approval channel. All original questions, options,
descriptions, multiple selections and custom answers stay attached to the exact
native chat and call. A permission Allow without complete answers is rejected.
Auto allow never invents an answer. An unreachable relay leaves Claude's local
question UI available. When the phone received the question and 100 seconds pass
without an answer (Claude stops the hook at 120), `deferredQuestionOutput` denies
the call with a reason that asks Claude to end its turn with the same question.
The `claude-open-questions` feature then keeps it on the phone until it is
answered there or at the computer. Successful answers return the original
`questions` and an `answers` mapping using Claude's documented PreToolUse
`updatedInput` contract.

Tests: `tests/`. Engineering contract: the Apple repository `AGENTS.md`.

License: GrantTap Commercial Source License; see the repository LICENSE.
