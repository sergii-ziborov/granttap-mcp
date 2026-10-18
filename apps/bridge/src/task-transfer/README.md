# Prepared task transfers

Public entry: `index.ts`. Preparing a destination persists the stable Task,
original title, isolated worktree, provider/model and complete visible context.
It does not invoke an agent. The first user message creates one native execution;
subsequent messages resume that execution behind the stable prepared chat id.

The private context file is checksummed and survives process restart. Missing or
oversized context refuses preparation instead of silently dropping history.
A launch is recorded before invoking the provider. An interrupted first launch
requires inspection and cannot automatically create a second native execution.

Tests: `tests/prepared.test.ts` covers preparation, restart, model/effort forwarding,
context persistence, stable catalog identity and ambiguous first submissions.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
