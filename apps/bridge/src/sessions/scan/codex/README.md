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

## How a turn ended (`outcome/`)

Codex CLI 0.16x ends a turn with `event_msg` `task_complete`: the answer in `last_agent_message`, or
`null` there and `error: { message, codex_error_info }`. Its messages also arrive as `item_completed`
items (`UserMessage`, `AgentMessage`, `Extension` for the image tool), next to or instead of the older
`response_item` messages. The scanner reads them all:

- A stopped turn: the session's `summary` is `Codex stopped: <Codex's first sentence>` (links and offers
  dropped), `stopped { reason, message, at }` is published, and `usage_limit_exceeded` with a readable
  "try again at 4:45 PM" (or "Nov 18th, 2026 4:45 PM", in this computer's zone) adds `usageLimit
  { resetsAt }`. A limit that reset over an hour ago is dropped; the next turn clears both. The
  transcript ends with the same sentence as a `final` entry with `outcome: "error"`. Codes map to
  reasons: `usage_limit_exceeded` → `usage_limit`, `rate_limit_exceeded` → `rate_limit`,
  `context_window_exceeded` → `context_window`, `unauthorized` → `sign_in`, server and connection
  failures → `service`, anything else → `error`.
- An answer only an item or the turn's end carries is the chat's answer: it sets `summary`, and the
  transcript shows it. An `AgentMessage` item repeats the `response_item` message with its id that
  follows it; it is held until its turn ends and shown only when that message never came, so
  transcripts keep their ids. The turn's `last_agent_message` is shown only when no message of the turn
  said it and the page began with the turn.
- A finished image tool call is a `tool` row `Picture saved: <file>`. A headless run (`codex exec`)
  whose final answer names an image it saved inside its working folder in this turn shows `Picture
  saved: <file name>` as its `summary`, and the picture is kept and attached
  ([chat pictures](../../../helper-runs/README.md#pictures-a-chat-saved)).
- A request only a `UserMessage` item carries names the chat when nothing else does.

**Chats nobody asked anything.** A rollout with no words of the person's (no user row with visible text,
no head request, no `UserMessage` item) and no answer is not published: no chat, no lineage, no Mesh
Task. Once its request appears it is. A run whose request never came stays out. A forked agent is
kept under its parent.

Tests live in [`tests/`](tests/) and `outcome/tests/` (synthetic rollouts of each shape: a limit stop,
an image run, items-only and turn-end-only answers, an older rollout, a run with no request). The selected-Page regression covers the public
catalog, cached rescans, live activity, and paginated transcript history.

Missing rollout lookups use the bounded [rollout identity index](rollout-identity/README.md).
They do not read unrelated large activity tails. Unchanged file identities are
reused; file changes invalidate them, and the selected chat keeps its existing
activity window. `tests/rollout-lookup-cost.test.ts` measures the actual read budget.
