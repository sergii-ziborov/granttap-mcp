# Codex desktop questions

Public entry: `index.ts`. Native `request_user_input_async` questions are read
from discovered Codex rollouts and sent to paired controllers as ordinary
GrantTap question cards. Choice labels remain visible in the question; the
person can type or speak the answer. The question, Task and native call retain
their identities. No new provider, approval policy or pairing is created.

The monitor checks only bounded tails of known chats every two seconds. Unchanged
sources reuse their revision. Pending questions survive monitor restart and are
replayed when the phone reconnects or refreshes; repeat scans do not send another
wake notification. A native answer clears the corresponding card across devices.
After a day, a GrantTap card expires without claiming the native question was
answered. The Codex conversation remains the source of truth.

Replies use the original host question item ID and normal scoped phone delivery,
including current provider, pause and Task policy. Native admission uses one
stable delivery ID per question, so concurrent controllers cannot submit two
different answers. The phone's own message ID still receives its receipts.
If the desktop owner is unavailable, question replies do not launch a separate
CLI writer. An uncertain admission is not replayed or described as a confirmed
native answer. Native transcript files are read without modification.

Tests under `tests/` cover publication, reconnect replay, native acknowledgement,
scope rejection, expiry and delivery through an isolated native IPC fixture.

License: GrantTap Commercial Source License in the repository-root `LICENSE`.
