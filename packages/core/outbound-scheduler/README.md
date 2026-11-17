# Encrypted outbound scheduling

Public entry point: `index.ts`. Preserves per-peer encrypted envelopes while
pacing a connection below the managed relay's 300-frame-per-second admission
limit. Explicit approval and configuration messages take priority over queued
replaceable snapshots. Encrypted results explicitly marked for wake delivery
also precede replaceable snapshots, including sealed transfer receipts. TCP write completion, bounded queued bytes, cancellation
on disconnect, and a fresh queue on reconnect prevent stale bursts from crossing
connection generations. No message content or keys are logged.

The queue holds at most 2,048 frames or 8 MB. A frame that would not fit first
takes the place of the oldest queued replaceable snapshots, which are rejected as
superseded; only a queue of controls refuses with "relay outbound queue is full".
A burst of catalog and Mesh refreshes for hundreds of short runs once filled the
queue and refused 103 Graph answers in a day; a Graph answer now also travels in
the control lane.

Disconnect rejects the current write as well as queued frames. Catalog and
history publishers can retry on the next connection even if the previous
socket never calls its write-completion callback.

Supporting relays negotiate an ingress window and cumulative read receipts.
At most 64 frames then wait for relay reads, in addition to the existing pace.
Short TCP buffering or a slow relay cannot release several seconds of ordinary
traffic as one excessive burst. Controls retain queue priority and reconnecting
creates a new counter generation. Managed admission renewals use their separate
control lane. A read receipt proves no persistence, decryption or task delivery.

Tests live in `tests/`; they include an actual WebSocket server with the relay's
rate limit. A socket write is transport evidence, never an approval receipt.

GrantTap Commercial Source License; see the repository LICENSE.
# Controller delivery

Catalogs, liveness and shared conversation updates reach every authorized
controller, including a phone receiving passively. Silence never removes access
to its local replica. Authenticated history, subscription and image requests
return their independent key grant and encrypted result only to the requesting
controller, with priority over queued periodic snapshots. Older callers without
a requester retain the complete authorized recipient set. Every explicit target
passes the pairing and controller authorization checks. Routing never deletes a
pairing or changes approval policy.

Answers a phone waits on (image chunks, a chat's changes, a commit's result)
retain their local scheduling priority through task encryption and precede
background transcript backfill. Queued behind a backed-up upload, a chat's
changes once arrived after the phone had stopped waiting, or were dropped as a
superseded snapshot without a word. The local `urgent` send
hint is never serialized into relay routing metadata and does not request APNs.
The image-priority test receives and decrypts both layers and verifies ordering
while preserving every background frame and the existing six-millisecond pace.
