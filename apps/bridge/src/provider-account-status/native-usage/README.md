# Native account allowances

Public entry: `index.ts`, exported by the parent Provider Account Status module.
Reads the existing Claude, Cursor and Grok account interfaces without creating
sessions or changing credentials. `projection.ts` retains only usage windows;
`credentials.ts` bounds local native credential reads; `reader.ts` coalesces,
throttles and expires the independent requests. Native status-line observations
keep their actual timestamps and can supersede direct Claude observations.

Tests live in `tests/`; the parent README documents data sources and boundaries.

GrantTap Commercial Source License. See the repository root LICENSE.
