# Cursor IDE continuation context

Public entry: `prepareCursorContinuation` in `index.ts`.

The IDE catalog and Agent CLI may reuse a conversation ID while keeping separate
local history. The first phone continuation retains the IDE's visible root user
and assistant messages in a private bounded archive, supplies recent messages
through stdin, and names the full archive for earlier context. Private reasoning,
child conversations and tool results are excluded. The provider must inspect
the current repository when old tool results matter.

Successful completion records the import for that exact session and workspace.
A failed or interrupted turn cannot mark it imported. Later turns resume the
CLI's own history without repeatedly charging for the same snapshot. Existing
task identity, workspace, policy scope and permissions remain unchanged.

Tests in `tests/` cover retained intent, bounds, privacy and reopen behavior.
This module uses the GrantTap Commercial Source License in the repository LICENSE.
