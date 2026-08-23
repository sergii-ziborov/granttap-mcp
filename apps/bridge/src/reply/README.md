# Task delivery

This module prepares phone attachments, routes selected MCP/skill intent, and runs local agent commands. The public `reply.ts` entry point owns session queueing and agent-specific command selection.

`provider-headless.ts` owns the provider-neutral headless start used when a Mesh
handoff resumes the same Task on another agent or computer. Providers without an
implemented remote-start path fail closed instead of reporting parity.
