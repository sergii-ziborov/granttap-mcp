# Codex session catalog and activity

Part of GrantTap MCP, licensed under the [GrantTap Commercial Source License](../../../../../../LICENSE).

Public entry point: [`index.ts`](index.ts). This module reads native Codex
rollouts into GrantTap's Task catalog, root conversation history, nested child
conversations, and observed capability usage.

Titles and user messages use the same visible-text boundary. Host-injected
selected-Page blocks, including a null selection, do not name a Task or appear
as a person's message. A real request next to that context is retained. Ordinary
JSON requests remain visible. Native rollouts are read without modifying the
provider's conversation files.

Forked child rollouts retain their first native identity. Copied parent metadata
and entries older than the child's creation are excluded from the child's
catalog, activity and usage; they must not replace the root Task or double count
its history. `tests/forked-agents.test.ts` covers cached rescans and all three
nested conversations through the public catalog and activity readers.

Tests live in [`tests/`](tests/). The selected-Page regression covers the public
catalog, cached rescans, live activity, and paginated transcript history.

Missing rollout lookups use the bounded [rollout identity index](rollout-identity/README.md).
They do not read unrelated large activity tails. Unchanged file identities are
reused; file changes invalidate them, and the selected chat keeps its existing
activity window. `tests/rollout-lookup-cost.test.ts` measures the actual read budget.
