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
checkout path, preferring an admitted canonical binding over a duplicate local
alias. Failed bindings remain visible with their original error. Both the Mac
projection and phone refresh use this rule. The graph contains actual Engine
analysis; unavailable analysis is never synthesized as a successful graph.

Behavior tests: `tests/`, root `tests/graph/graph-binding-sync.test.ts`, and
`apps/mcp/src/desktop/projection/tests/graph-refresh.test.ts`. The optional
`engine-selection-live.test.ts` uses `GRANTTAP_ENGINE_TEST_BINARY` to verify the
actual native scanner respects `.git/info/exclude` and retains untracked source.

## License

Apache License 2.0. See [LICENSE](../../../../../../LICENSE).
