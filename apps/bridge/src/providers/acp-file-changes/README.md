# Confirmed ACP file changes

`confirmedUpdateChanges` in `index.ts` projects bounded native diff content after
its owning tool reports successful completion. Grok and Cursor share this
projection. Pending, failed and unrelated updates cannot establish file edits.
Sensitive paths, traversal, malformed content and excessive files are excluded;
previews redact secrets and state truncation. Behavioral tests live alongside
the consuming Grok and Cursor conversation features.

Licensed under the repository-root GrantTap Commercial Source License.
