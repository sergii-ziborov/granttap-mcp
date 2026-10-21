# Bridge Configuration

This module owns local runtime policy, exact-session capability controls, paths,
and device pairing serialization. `index.ts` is its public entry point.

Behavior is covered by `tests/config.test.ts`, `tests/capabilities.test.ts`, and
`tests/core.test.ts`.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.

Runtime startup and persistent OAuth share `runtime/node-requirement.mjs`, which
reads the package Node minimum before loading TypeScript dependencies. Runtime
compatibility regressions live in `runtime/tests/node-requirement.test.ts`.
