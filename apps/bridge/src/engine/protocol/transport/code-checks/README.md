# Measured source checks

Public entry: `index.ts`. The Engine response parser admits optional, measured
function size, token-based complexity, nesting and resolved call fan-in. Absent
measurements stay absent. Malformed, negative and out-of-range values fail the
response instead of becoming healthy zeroes.

Integration tests: `runtime/repository-graph/tests/code-checks.test.ts`, relative
to the Engine module. The additive fields remain compatible with older Engines.

License: GrantTap Commercial Source License; see the repository LICENSE.
