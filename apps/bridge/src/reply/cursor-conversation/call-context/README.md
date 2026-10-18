# Native Cursor action context

The official CLI may send permission RPCs containing only a call ID, kind,
title and display content. `CursorCallContext` retains the bounded action
arguments from preceding `session/update` tool frames and joins them only to
the same session, native call ID and kind. Uninspectable actions fail closed.
The cache stays in memory and never logs native arguments.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
