# Native Grok activity

`grokNativeActivity` reads at most 64 KiB of the native structured event log.
It confirms the active registry PID and OS process start time before treating a
turn as running. Summary writes alone cannot prove that Grok is idle during a
long turn. Permission phases remain waiting; completed turns are idle.

The session catalog consumes these observations, and the resume adapter checks
them again before launching a headless process. A queued phone message waits
for the current native turn instead of loading the same running session twice.
No prompt, reasoning, or native event contents are published by this reader.

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
