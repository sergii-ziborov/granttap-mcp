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

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
