# Task key persistence

`persistedSessionKey` preserves one stable task encryption key across concurrent
MCP processes. New keys use an exclusive computer-local creation lock, re-read
the current dictionary under that lock, and atomically replace the protected
snapshot. Existing keys remain readable without waiting for another creator.
An unreadable dictionary is never replaced with an empty one. Locks left by
terminated owners can be recovered; active owners are never displaced.

The public transport entry remains `../session-keys.ts`. Tests exercise actual
concurrent processes and the durable dictionary without logging key material.
This module uses the repository GrantTap Commercial Source License.
