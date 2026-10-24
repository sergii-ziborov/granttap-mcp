# Repository graph refresh

Public entry point: `analysis.ts` for explicit builds; `binding-sync.ts` for
verified local admission and recovery; `checkout-identity.ts` for checkout scope.

A remote identity must match the checkout's observed Git origin. A `local:`
identity must resolve to the exact Git root it names. Gaining an origin does not
invalidate an existing local-directory binding or move it to another Project.
Local bindings are admitted to Engine as path identities without a canonical
remote claim. Changed remote identities and local paths to different checkouts
remain rejected. Neither Task identity nor Project membership is rewritten.

After admission, `graphAnalysisBindings` selects one graph per endpoint and real
checkout path, preferring the currently verified canonical binding over retired aliases.
Observed Git revisions replace old catalog observations in admission and report
provenance. A subfolder with a remembered parent commit is not a checkout. Each
computer analyzes only its own endpoint bindings. Failed bindings remain visible with their original error. Both the Mac
projection and phone refresh use this rule. The graph contains actual Engine
analysis; unavailable analysis is never synthesized as a successful graph.

After repository analysis, explicit builds request bounded cross-repository
contract matches from the same admitted bindings. These are projected as shared
static contracts with an unverified runtime target. Background snapshots reuse
fresh in-memory results; they do not queue additional multi-repository scans.
A verified Backbone remains authoritative. Project identities and grants are
preserved.

Behavior tests: `tests/`, root `tests/graph/graph-binding-sync.test.ts`, and
`apps/mcp/src/desktop/projection/tests/graph-refresh.test.ts`. The optional
`engine-selection-live.test.ts` uses `GRANTTAP_ENGINE_TEST_BINARY` to verify the
actual native scanner respects `.git/info/exclude` and retains untracked source.

## License

GrantTap Commercial Source License. See [LICENSE](../../../../../../LICENSE).
