# Project restrictions

`index.ts` is the public entry point. `write-gate.ts` reconstructs candidate
content for supported native write tools, and `evaluate.ts` checks bounded file
limits. Function extent currently uses a brace-depth scanner for recognized
declarations. Arrow functions, methods and Python definitions that it cannot
verify yield ASK instead of a false clean result. A parser-backed replacement
is still required for complete language coverage and exact spans.

Tests live in `tests/project/project-restrictions.test.ts` and
`tests/project/restrictions/function-restrictions.test.ts` at repository root.

License: this module is distributed under the MIT License
in the repository-root `LICENSE` file.
