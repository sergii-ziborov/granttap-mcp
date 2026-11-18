# Task delivery

An explicit Grok Build usage-balance refusal is returned as a usage error rather
than a startup timeout or a successful answer. Both stderr exits and streaming
error events use the same explanation. Earlier confirmed response activity stays
recorded if a turn later fails; an error alone never creates admission evidence.

This module prepares phone attachments, routes selected MCP/skill intent, and runs local agent commands. The public `reply.ts` entry point owns session queueing and agent-specific command selection.

`provider-headless.ts` owns the provider-neutral headless start used when a Mesh
handoff resumes the same Task on another agent or computer. Providers without an
implemented remote-start path fail closed instead of reporting parity.

A phone delivery's Claude, Codex or Grok run writes to files in a folder of its own and
survives a monitor restart; the next monitor takes it over and sends its answer
([`survival/`](survival/README.md)).

`in-flight.ts` holds a chat's key until its run settles, which is when this monitor sees the provider
process end or at the run's deadline (six hours for a phone run). `run-watch.ts` watches the provider
processes started under each key (the key and any key around it, such as a moved Task's `transfer-…`
around its provider's new-task key) and looks at the process table once a minute while any run. A
runtime update stops counting a run (`blockingDeliveries`) whose process is gone, a zombie or its pid
reused for two minutes, whose process exited without the run ending for two minutes, whose work is still
pending ten minutes after its process ended, or whose process group wrote nothing and used under a second
of processor time a minute for thirty minutes. The monitor log says so once per run: `A runtime update no
longer waits for the run in chat … that started … min ago: <why>.` The run itself is left alone, and work
that never started a provider process, such as a Codex desktop delivery, is never judged. Before this a
moved Task's turn whose process went without its end being seen kept every update waiting until its
deadline. Tests: [`tests/run-watch/stalled-run.test.ts`](tests/run-watch/stalled-run.test.ts).

On POSIX, a managed provider command owns a process group. Phone pause and
timeouts signal that group, so local descendants that remain in it are also
requested to stop. The stop count records accepted signals, not confirmed exit
of every descendant. Windows uses the direct-child stop path; remote jobs and
resources that outlive the agent process need their own cancellation receipts.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.

Model reasoning effort reaches resumed and new provider turns as native arguments.
Codex uses `model_reasoning_effort`; Claude uses `--effort`; Grok uses
`--reasoning-effort`. Cursor effort variants are native model IDs.

Accepted levels: Codex `low…ultra`, Claude `low…max`, Grok `low…xhigh` (Grok
Build lists `xhigh` for its current models and has no `max`). Anything else is
dropped rather than passed. A prepared transfer's first turn uses the model and
effort that message carries, else the capsule's `targetModel`. Grok Build is
resolved with `providers/grok-bin.ts`. Tests:
[`tests/model-effort-args.test.ts`](tests/model-effort-args.test.ts).

A resumed headless Claude or Codex turn that names no effort keeps the chat's own: the
one its latest request used, as its catalog row reports it (`resumedEffort`). Without
the flag the CLI starts at its own default instead. On the owner's Mac, Claude Code ran
phone follow-ups at medium in chats begun from the phone at xhigh, though its settings
said xhigh, and a Codex resume takes config.toml's level. Codex levels differ by model,
so a turn that switches the Codex model keeps nothing it did not choose; Claude Code
retries a level a model refuses without it. A chat that reported no effort, or a level
the provider does not have, resumes as before. The model is not carried this way: a
Claude chat reports the resolved model id, which cannot say whether a 1M-context
variant was chosen. Tests: [`tests/turn/phone-task-controls.test.ts`](../../../../tests/turn/phone-task-controls.test.ts)
drives phone-shaped messages through the monitor to the exact Claude and Codex command lines.

Explicit Cursor task turns pass `--trust` for the selected workspace so an
updated CLI cannot wait for an invisible desktop trust prompt. Resumes without
a reported workspace are refused. Tool approvals and global action bans remain
active; `--force`, `--yolo` and automatic MCP approval are never added.

An existing Codex desktop conversation receives follow-ups through its native
owner, without a competing `exec resume` writer. The `codex-desktop` feature owns
that versioned local connection and durable admission receipt. Headless resume is
used only when no native owner exists. Native admission carries the controller's
message ID and returns promptly; the provider transcript supplies the answer.
Local image and document files remain available for one day after native
admission, because accepting a queued turn does not mean its files were read.
The regular attachment sweep removes expired stages without following symlinks.

New and resumed headless Codex tasks both accept workspaces outside Git. The
repository presence check is skipped consistently; configured sandbox, approval,
and hook trust settings still apply. This also lets a task started in the general
workspace receive subsequent phone messages without changing global trust.
