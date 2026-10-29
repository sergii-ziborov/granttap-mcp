# Repository source observation

Public entry: `index.ts`. This private machine-side observation identifies the
bound checkout, Git revision, staged and unstaged path status, and metadata of
changed or untracked files. It includes repeated edits with the same Git status,
renames, deletion and Unicode paths. Ignored build output does not invalidate it.
It reads metadata without parsing source or executing a build.

Background observations share in-flight work and a five-second observation
window. Explicit refresh bypasses it. Output, path count, filesystem concurrency
and retained observations are bounded. Unreadable or invalid state remains
unknown; it never becomes proof of unchanged source.

Repository graph jobs retain a successful report while this observation is
unchanged, including across MCP restart. A changed observation retains the
existing analysis cooldown; explicit builds still force analysis. Failed or
legacy reports retain normal retry behavior. No provider policy, grants,
repository files or user projects are changed.

Behavior tests live in `tests/` and `../tests/unchanged-source.test.ts`.
