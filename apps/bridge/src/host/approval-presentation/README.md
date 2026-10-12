# Approval presentation

Public entry: `index.ts`. Hook adapters send a bounded, credential-redacted
parameter preview with an approval. Browser batches name their operations so
the person can inspect the request before deciding. Presentation does not
alter provider input, classify an unknown operation as safe, or authorize it.

Behavior tests live in `tests/`.

License: MIT License; see the repository LICENSE.
