# Repository Git observations

`index.ts` is the public read-only entry point for local repository facts.
Existing Mesh bindings choose the checkout and endpoint. Foreign, unavailable
and pathless bindings are excluded. Git runs without optional locks, with
bounded output and per-command timeouts. No Git remote credentials or author
emails are published.

The optional encrypted `repositoryDetails` snapshot field carries observed
canonical identity, branch, HEAD, working tree state, up to eight recent commits,
up to twelve contributors, branch totals and observation time. Missing Git and
unavailable checkouts are distinct from an empty repository. Unknown counts are
not zero. The phone publisher and native Mac reader share this enrichment.

Claude and Codex scanners independently observe sustained structured tool
working directories. Claude also observes absolute Write/Edit paths. Literal
initial `cd` and `git -C` commands are recognized without executing shell code.
A recent unambiguous majority in a confirmed Git checkout can supersede the
session's initial workspace. Titles and chat prose never select repositories.
The Apple client uses this evidence for placement, preserving durable Task
identity and access scope.

Background Mesh publication shares one asynchronous checkout observation across
admission, Graph selection and repository details. It reads working-tree status
on every publication. Bounded history for an unchanged commit can be reused for
up to 30 seconds in the background; explicit observations bypass that cache.
History commands name the observed commit so a concurrent commit cannot silently
substitute another revision. At most 128 history observations remain in memory.
History, status and checkout metadata share a maximum of two native Git
subprocesses, keeping background publication off the relay's event loop.

Behavior tests live in `tests/`. See the [runtime README](../../../../../README.md).

Licensed under the [GrantTap Commercial Source License](../../../../../LICENSE).
