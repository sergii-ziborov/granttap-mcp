# Question answer presentation

Public entry: `questionAnswerPresentation` in `index.ts`. Run journals and Task
progress show human answers before storage limits truncate them. Presentation
does not alter the native envelope used for delivery or transcript confirmation.
Malformed or truncated envelopes use a neutral label. Tests cover normal text,
quoted examples, multiple answers, document staging notes, and invalid envelopes.

License: [GrantTap Commercial Source License](../../../../../LICENSE).
