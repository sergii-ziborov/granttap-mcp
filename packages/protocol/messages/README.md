# Protocol Messages

This module owns the bounded encrypted message schemas shared by GrantTap clients.
`../schema.ts` is the public entry point and assembles the payload union and relay envelope.

`mesh.ts` adds the Project Mesh contract: stable Project/Task identity, execution
links, TTL resource claims, dependencies, bounded coordination events, and the
Task Capsule plus SHA-256 handoff receipt. `mesh-endpoint.ts` adds the scoped
Grok Bot endpoint, its one-time invite, credential, actors, and revocable policy.
Both are strict schemas: unknown fields are rejected, and transcripts or hidden
model reasoning are outside the contract.

`questionDecline` (optional, `"decline-v1"`) on an `agent.event` question or an
`approval.request` says its waiting agent accepts a decline; on a `user.message` with
the same `requestId` it is the person's decline, whose `text` is never given to the
agent. A controller sends it only to a question that advertised it, so a computer
from before the field never receives one.

`sessions/index.ts` carries the session record. `startedBy` (optional, strict:
`{ agent: "claude" | "codex" | "grok" | "cursor", sessionId }`, the id 8–128 of
`A–Z a–z 0–9 . _ -`, no other field) names the chat that started this one, when
another chat ran it headless and it is a chat in its own right. The parent may be
on another computer or gone. Short helper runs stay in the parent's
`childThreads` instead. See `apps/bridge/src/started-by/README.md`.

`stopped` (optional, strict: `{ reason, message?, at }`) says the chat's last turn ended on the
provider's error instead of an answer. `reason` matches `^[a-z][a-z_]{0,39}$` and is for the phone to
word; today `usage_limit`, `rate_limit`, `context_window`, `sign_in`, `service` and `error`, and a value
the phone does not know is shown by `message`: the provider's own first sentence without links, at most
300 characters. `at` is the stop's time in ms. The session's `summary` says the same in English
(`Codex stopped: …`), and a new turn clears both. A used-up subscription window also sets `usageLimit`
(`resetsAt` from the provider's "try again at …"); `autoContinue` is `false` for any agent this computer
does not continue by itself (everything but Claude).

`queueHold` (optional, strict: `{ reason: "usage_limit", until }`, a time in ms) says this computer holds the
chat's queued phone messages for its usage limit until about `until`: the reset, or its next try after the chat
was refused again. Send now still goes at once. Absent when nothing holds them; computers up to 0.8.200 never
send it. See `apps/bridge/src/limit-queue-hold/README.md`.

`workingTree` (optional, strict) and the `session.changes.query` / `session.changes.result` and
`session.commit` / `session.commit.result` messages live in `sessions/working-tree.ts`; the contract
is in `apps/bridge/src/working-tree/README.md`.

`startedChildren` (optional, strict: `{ finished, stopped, limited?, pictures, lastAt }`, non-negative
integers and a time in ms) counts every finished chat this chat started headless, however long ago, the
newest three included, which stay rows of their own with `startedBy`: all of them, those that stopped on
an error (a limit among them), those a usage or rate limit stopped (`limited`, added after MCP 0.8.193;
absent from older runtimes), and those that saved a picture. MCP 0.8.190–0.8.193 counted only the runs within
the catalog's window of 200 transcripts.

`sessions.children` (strict: `{ parent, children, total, generatedAt }`) lists, newest first and at most
4,000, the session ids of every chat this computer knows `parent` started, and `total` of them, so a
phone can hang beneath their parent, or leave out, rows and Mesh Tasks it keeps from before it knew.
A phone that does not know the message ignores it. See
`apps/bridge/src/session-catalog/started-children/README.md`.

`images` (optional, at most 12 of `{ id, name, markdown }`, the same shape as a helper run's
`childThreads[].images`) lists pictures the chat's own answer saved in its working folder, kept by the
computer. Ids start `helper-image:` and are read with `session.image.query` on this chat or on its
`startedBy` parent. The transcript carries the same picture on the answer that names it, as an
`ActivityEntry.images` item whose `markdown` is that answer's path line.

`capabilities.ts` keeps resource evidence optional and bounded. CPU, RAM, I/O,
and process counters carry an explicit measured, attributed, estimated, or
unknown provenance instead of implying ownership the runtime cannot prove.
`capability.usage.status` may carry `tokenUsage` (optional, strict: `{ windows, hours }`), when the
computer's chats spent tokens and where they went. `windows` (at most 3, `windowHours` 24, 168 or 720)
each hold `tokens`, every chat's spend in the period, and the heaviest chats (`chats`, at most 12 of
`{ sessionId, agent, model?, tokens }`) and models (`models`, at most 16 of `{ agent, model, tokens }`,
never an empty model), heaviest first. `hours` (at most 25, oldest first) are the clock hours of the
last day with spend, `{ startedAt, tokens }`. Tokens are what each provider adds into a chat's
`tokensSession`. Computers up to 0.8.211 never send it. See `apps/bridge/src/sessions/token-usage/README.md`;
tests live in `tests/`.

`project-policy.ts` carries explicit `project.policy.set`, status, and endpoint
acknowledgement records. They are project-scoped, revisioned, size-bounded, and
sealed with the same independent Project key as Mesh snapshots. Coverage keeps
`enforced`, `observed`, `unsupported`, and `unknown` distinct so clients never
claim a provider can block an action when it cannot.

`device/controller-pairing.ts` lets an authenticated controller ask its linked
computer for another one-time controller credential. The reply is sealed only
to the requester. It is device-network pairing, not Project membership.
`device/management.ts` carries `device.manage` and its `device.manage.result`, the phone's controls for
one computer. Its status snapshot lists the computer's paired phones (`phones`, by `id` = sha256 of the
key, never the key), and `phones-remove`, `phones-remove-stale` and `phones-unpair-self` remove them;
see `apps/bridge/src/paired-phones/README.md`.
`device/workstation.ts` is the snapshot's optional `workstation`: load (memory, swap, CPU, the home
volume, the heaviest apps), the last space summary with each entry marked `regenerable`, `history`,
`protected`, `context`, `user-data` or `inspect`, whether one is running, and the settings that
`workstation-settings` changes (`automaticScan: smart | off`, `lowSpaceAlert`); `workstation-scan`
measures now. Nothing in it deletes; see `apps/bridge/src/workstation/README.md`.
`mesh/knowledge/write.ts` carries a Task-bound human decision or correction and a
separate Engine-confirmed result.
`mesh/repositories/index.ts` carries `mesh.repository.query` and its
`mesh.repository.list` of a computer's checkouts (at most 200, bound ones
first), and `mesh.repository.edit` (`add` a checkout by absolute path,
`remove` one of the computer's bindings by id) with its
`mesh.repository.edit.result`. Each is Project-scoped (`sessionId` is the
`projectId`); a refusal always names its reason.

`mesh/graph/code-file.ts` carries `project.code_file.query` and its `project.code_file.result`: every
section of one file of a repository's code map, which the Mesh snapshot's bounded `codeMap` may list
only in part. The result's sections are the code map's own `CodeSymbol` objects; it is at most 2,000
sections and 160 KiB, and its `status` is `ok`, `analyzing` (keep waiting), `not_found`, `not_bound`,
`engine_unavailable` or `analysis_failed`. The snapshot gains no field for it. See
`mesh/graph/README.md`.

`sign-in/index.ts` carries a browser sign-in done on the phone: `signin.request`
names an https page, the service, and optionally the loopback port a command
listens on; `signin.result` says `completed` or `cancelled` and may carry the
path and query of the loopback redirect, bounded and free of characters that
could end a request line. Tests live in `sign-in/tests/`.

`live-map/index.ts` carries a chat's live map: `session.pulses.subscribe { sessionId, active }`
from the phone, renewed while the map is open, and `session.pulses` (strict) from the computer, at
most one frame a second with at most 48 pulses and 12 KB. A pulse names a station (the ten of
[lot-map](https://github.com/alexeyw/lot-map), MIT), a tool, skill, agent type or model name, its
phase, status, time, duration, a subagent digest and a parallel count, never an argument, path,
command or result. The contract is in `apps/bridge/src/live-map/README.md`.

Tests are discoverable in `tests/core.test.ts` and the feature-level bridge and MCP suites.

License: this module is distributed under the GrantTap Commercial Source License in the repository-root `LICENSE` file.
