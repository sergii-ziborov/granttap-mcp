# Device network

Public entry points: `settings.ts` validates and persists the explicit managed,
direct, or self-hosted mode; `directory.ts` publishes short-lived authenticated
encrypted endpoint announcements for each approved controller.

Direct routing overlays the pairing address without replacing its room, keys,
Task IDs, or delivery IDs. The managed directory receives opaque ciphertext,
expiry and room/recipient routing identifiers. It does not proxy direct traffic.
The user must provide a reachable TLS endpoint; this does not create NAT
forwarding or promise background iPhone delivery. Self-hosted mode has no
managed directory announcement. Settings never contain pairing secret keys.

Behavior tests live in `tests/network.test.ts`. This machine runtime module is
covered by the repository MIT License; the separately installed relay follows
its own license and customer terms.

This runtime module is covered by the repository MIT License.
