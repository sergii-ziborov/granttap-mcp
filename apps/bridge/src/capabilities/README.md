# Capability catalog

This module discovers provider-configured MCP servers and available skills. Metadata probing is isolated because it may start an MCP transport; local descriptors and skill discovery remain read-only.

Codex descriptor results, including failed lookups, are shared for 30 seconds.
A failed native CLI query retains the last known descriptors and is retried
after that window; it never repeats its timeout for each chat in one catalog.

Skill digests cover the bounded bundle, including scripts and references.
Catalog observations and Project requests do not install a skill or native MCP
configuration on another host. Availability requires a separate native apply
and independently observed initialization; that rollout is still unfinished.

MCP descriptions come from `initialize.serverInfo.description`, trimmed and
bounded to 4,000 characters. Descriptions, validated icons and website metadata
travel with both session and Project catalogs; conflicting native implementations
do not borrow an implementation's description or icon. These are display data,
not instructions or evidence that a capability was used.

License: this module is distributed under the GrantTap Commercial Source License in the repository-root `LICENSE` file.
