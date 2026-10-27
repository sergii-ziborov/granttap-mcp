# Project coding guidance

`projectGuidancePrompt(projectId, text)` is the public prompt boundary. It loads
only the accepted local restriction set for the named Project, adds its
advisory principles, architecture preference, design targets and exact Markdown,
then preserves the original request. Empty guidance is a no-op. It never edits
provider configuration or raises tool permissions.

Continuation delivery calls this through the existing routing prompt for all
supported providers. New phone Tasks use the Project returned by validated
workspace admission. Transfer starts use the existing Task's Project scope.
A loose cwd or unvalidated message Project ID does not supply instruction scope.
Original delivery identities, origin records and run journals retain the person's
original request; attached guidance is not a separately delivered prompt.

The optional protocol field is backward compatible for reading old sets. A Mac
that predates this contract must be upgraded before a phone sends guidance;
strict old protocol receivers cannot honestly acknowledge a field they reject.
The canonical policy receipt proves local acceptance, not semantic compliance.

The private store and `.granttap/restrictions.json` export preserve all guidance.
The explicit repository check reports guidance as advisory and never claims to
machine-check Clean Code, architecture, class or parameter targets. Existing
write checks own numeric enforcement; Ruby/Python function forms outside the
brace scanner request parser review.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
