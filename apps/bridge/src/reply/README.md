# Task delivery

This module prepares phone attachments, routes selected MCP/skill intent, and runs local agent commands. The public `reply.ts` entry point owns session queueing and agent-specific command selection.

`provider-headless.ts` owns the provider-neutral headless start used when a Mesh
handoff resumes the same Task on another agent or computer. Providers without an
implemented remote-start path fail closed instead of reporting parity.

On POSIX, a managed provider command owns a process group. Phone pause and
timeouts signal that group, so local descendants that remain in it are also
requested to stop. The stop count records accepted signals, not confirmed exit
of every descendant. Windows uses the direct-child stop path; remote jobs and
resources that outlive the agent process need their own cancellation receipts.

License: this module is distributed under the Apache License 2.0
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
