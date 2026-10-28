# Interactive Cursor conversation

`index.ts` owns Cursor's official ACP stdio conversation. Existing credentials
are reused; the adapter never runs a provider login, installs a CLI, enables
unrestricted tools or retries a failed resume as a new Task.

Native question, plan and permission requests remain pending while the GrantTap
controller answers. Questions preserve native question/option IDs and require
complete explicit selections. Permissions use one-call choices, apply computer
and Project denials first, then the existing Task auto-accept policy. Unknown
interactions fail closed. The configured workspace alone is trusted for this
explicit Task continuation.

The transport bounds frames and pending requests, excludes thought chunks and
diagnostic streams, deduplicates native request IDs, and registers the owned
process with the existing Task Stop path. Ending that process cancels pending
phone forms. Loading native history never becomes a new assistant response.

Protocol: https://cursor.com/docs/cli/acp

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.

A new native session is bound to its prepared Task before the first prompt or
question. Session creation is not an agent-admission receipt. Visible tool
updates flow into the bounded conversation archive; thinking and raw arguments
remain excluded. Reply text contains the final segment after the last tool.
