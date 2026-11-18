# Waiting-provider cancellation

`index.ts` binds one approval registration to its owning process's abort signal.
Ending that process cancels the durable request, publishes its terminal state
and releases the waiter. Cancellation never manufactures an Allow or answers a
question. Other live approval registrations and shared clients remain intact.
A string abort reason, such as a phone declining a yes/no question, becomes the
terminal note; otherwise the note says the agent stopped waiting.

License: GrantTap Commercial Source License, in the repository-root `LICENSE`.
