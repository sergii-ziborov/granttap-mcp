# Effective action policy

`effective-action.ts` is the public implementation entry point for combining
the private engine's Project decision with the existing provider/session flow.
It resolves only already-known local Project state, uses one shared 50 ms IPC
deadline, and falls back to the established GrantTap behavior when rollout is
disabled or the engine cannot answer.

`capability-fingerprint.ts` turns provider tool metadata into a bounded
capability fingerprint. It never copies raw tool arguments, commands, secrets,
or absolute file paths into the fingerprint. Project `DENY` and `ASK` are parent
boundaries; legacy bypass, paused gating, and auto-accept may run only after an
`ALLOW` or `INHERIT` result.

License: this module is distributed under the GrantTap Commercial Source License
in the repository-root `LICENSE` file.
