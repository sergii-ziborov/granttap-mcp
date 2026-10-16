# Cloud runners

Public entry point: [`index.ts`](index.ts). A Task can be sent from the phone or
the Mac app to a provider's own cloud runner, started by the computer that holds
the Task with the CLI installed there:

| Runner | Command the computer runs | What comes back |
| --- | --- | --- |
| Claude Code cloud session | `claude --cloud <capsule> [--name <title>] [--ref <branch>] [--model <m>] [--effort <e>]` | `Session ID:` and `View:` link |
| Codex Cloud task | `codex cloud exec --env <environment> [--branch <branch>] <capsule>` | the `…/codex/tasks/<id>` link or `task_…` id |

Both run with stdin closed and without a terminal. Claude Code then creates the
session, prints its id and link, and exits; it never waits for the cloud turn.
Where Claude Code would need the keyboard (its message *No cloud session was
created or opened: it would open in this terminal…*), the CLI's own words are
returned and nothing is started. Codex requires an environment: the person may
name it; otherwise `codex cloud list --json` is read once and an environment is
used only when exactly one recent task of this repository's `owner/repo` or
`repo` label names it. GrantTap never guesses one.

## Availability

`withCloudRunners` marks the `claude`/`codex` integration rows with `cloud: true`
only when that CLI is installed and its own help documents the headless start
(`--cloud [description…` for Claude Code, `Usage: codex cloud exec … --env
<ENV_ID>` for Codex). The help is read in the background, cached ten minutes per
binary path, and a status cycle never waits for it. Cursor and Grok Build have no
cloud runner here.

## What the Mesh records

[`mesh/runtime/cloud-handoff`](../mesh/runtime/cloud-handoff/index.ts) requires
the target computer to be the one holding the Task, pushes the capsule's branch
when the person asked (never by force) or confirms a remote-tracking branch
already contains the commit, and otherwise refuses with the reason. Uncommitted
work stays behind and the prompt says so, exactly like a computer transfer warns.

A started run becomes an execution of the Task with `external: { runner, url }`
and the CLI's id as its session id, plus a `TASK_PROGRESS` event naming the link.
GrantTap cannot observe a cloud run, so it reports no progress, state or usage
for it, and the vanished-session sweep never closes it. The local chat keeps the
Task while it is open.

The first message is the Task Capsule: goal, status, repository, branch and
commit, the person's comment, decisions and remaining work, bounded to 12,000
characters. The visible conversation archive is not uploaded.

Tests: [`tests/`](tests/). Apache License 2.0, see [LICENSE](../../../../LICENSE).
