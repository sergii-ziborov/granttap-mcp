# Runtime update preference

The public runtime-updates entry exports `runtimeUpdateSettings` and
`setRuntimeAutoUpdate`. The connection card stores the computer-wide choice in
`runtime-updates/preferences.json`, separately from version selection and pairing.
Missing settings retain the existing enabled default; unreadable settings pause
updates. A service-level `GRANTTAP_DISABLE_AUTO_UPDATE=1` takes precedence.

The monitor checks the saved preference before registry access and before
activation. Its loop observes changes without restarting. The launcher checks it
again before asking the owned service to drain or stopping that service. Turning
updates off retains the selected working version and startup rollback protection.

Integration tests in `../tests/preferences.test.ts` cover live off/on and an
in-flight update. Connection-center tests cover persistence through actual MCP
calls, pairing preservation, service overrides, and the DOM switch.

License: [GrantTap Commercial Source License](../../../../../LICENSE).
