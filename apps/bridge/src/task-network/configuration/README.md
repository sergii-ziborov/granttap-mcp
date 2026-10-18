# Latest Project transport configuration

Public entries: `ProjectConfigurationSync` in `sync.ts` and the monitor poller
in `runtime.ts`. `ciphertext.ts` defines the opaque mailbox ID and authenticated
decoder shared by the sync and native administrative surface.

The owner client saves a latest encrypted configuration on the relay. The
computer fetches it on startup and periodically while online, allowing a
previously offline computer to recover after the phone closes. Automatic
admission requires a fresh successful fetch. Expired, wrong-Project,
wrong-computer, revoked-controller and unauthenticated configurations grant
nothing. Revision and creation order are enforced by `TaskNetworkStore`.

Background discovery backs off for fifteen minutes when an opt-in configuration
is absent or rejected, and for one minute after a relay failure. Actual work
admission bypasses that delay and still requires a fresh authenticated response;
a remembered failure never becomes permission. Concurrent reads of one Project
join the same request, and retry bookkeeping is bounded to 128 Projects.

Native same-user configuration has a separate issuer domain and is accepted
only by explicitly enabled native stores. It never enrolls a machine as a
phone controller or grants ordinary controller message access.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
