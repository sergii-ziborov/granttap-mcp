# Native Task titles

`index.ts` selects human Codex Task names without changing transcript payloads.
Host question-reply envelopes and their clipped JSON metadata yield to the
original request. Ordinary JSON requests and quoted examples stay eligible.
Scanner behavior and retained history are covered in `tests/`.
