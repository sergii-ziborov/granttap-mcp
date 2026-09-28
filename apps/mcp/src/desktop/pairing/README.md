# Native desktop controller enrollment

`DesktopControllerEnrollment` is the private same-user socket entry point for
Mac Settings. `desktop.controller_enrollment` takes string inputs:

- `action: status` observes an existing enrollment.
- `action: create, confirmed: true` publishes a separate expiring controller QR.

It reuses the machine's room, retains existing devices, and never installs
provider hooks. Concurrent requests reuse the pending code. An expired code is
hidden; completion requires authenticated activity by the issued controller key.
The URI stays in the bridge process and its private response, outside public
HTTP status and ordinary tool output. Closing the bridge discards it.

The HTTP parent receives only a `pairing-changed` notification to reload its
relay peer list. The existing monitor reloads through the pairing helper.

Tests in `tests/` use disposable configuration directories and loopback relays.
They cover consent, the private socket, first pairing, additive enrollment,
expiry, exact-controller confirmation, and preservation on relay failure.

Licensed under the MIT License; see the repository LICENSE.
