# Cursor attention

Public entries: `cursorQuestionText`, `cursorNoticeText`, and `cursorNativeAttention`.
They project user-visible Cursor questions, their choices, and warnings into the
existing chat transcript. Cursor sometimes keeps question cards in its local
composer database without writing them to the JSONL transcript. The native reader
uses read-only indexed lookups of the exact composer's most recent 128 bubbles,
with a one-second timeout and bounded results. It never reads thought blocks,
changes native answers, or represents a displayed question as answered.

Tests exercise the public projection and an isolated SQLite database. Distributed
under the repository Apache License 2.0.
