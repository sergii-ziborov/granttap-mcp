# Task schedules

Public entry: `handleTaskSchedules`. The paired controller lists and edits existing
Codex heartbeat automations attached to admitted executions of the same Task and
Project. GrantTap does not create a scheduler or start provider turns here.

The local Codex version-1 mirror and native scheduling row must agree. Updates
preserve unknown fields and execution settings, use an expected revision, retain
private before/proposed checkpoints, and roll back the mirror if the native
transaction fails. Cloud migration, ambiguous databases, unsupported storage and
native edits make controls read-only. Pause removes future scheduling without
cancelling a running turn. Intervals use elapsed time; wall-clock rules use the
computer's time zone. There is no background polling.

Requests expire, repeat identities cannot repeat mutations, and replies go only
to the requesting paired controller under the chat's key. Content and identifiers
are bounded. Checkpoints remain private computer data, not disposable cache.

Tests beside this entry exercise native persistence, rollback, external changes,
scope, authenticated routing, lost receipts and repeated taps using isolated stores.

License: first-party code is under the GrantTap Commercial Source License in the repository LICENSE.
Third-party dependencies retain their own licenses and notices.
