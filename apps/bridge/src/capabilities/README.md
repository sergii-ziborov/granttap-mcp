# Capability catalog

This module discovers provider-configured MCP servers and available skills. Metadata probing is isolated because it may start an MCP transport; local descriptors and skill discovery remain read-only.

Codex descriptor results, including failed lookups, are shared for 30 seconds.
A failed native CLI query retains the last known descriptors and is retried
after that window; it never repeats its timeout for each chat in one catalog.

Skill digests cover the bounded bundle, including scripts and references.
Catalog observations and Project requests do not install a skill or native MCP
configuration on another host. Availability requires a separate native apply
and independently observed initialization; that rollout is still unfinished.

License: this module is distributed under the MIT License in the repository-root `LICENSE` file.
