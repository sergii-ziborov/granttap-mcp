# Computer controls from GrantTap

MCP 0.8.109 adds the paired-controller `device.manage` protocol. The iOS client
must also support these controls. A computer without an installed, connected
MCP cannot execute remote commands; install and pair MCP on that computer first.

Status reports the version of the running package, its process epoch, the
selected installed version, disposable cache sizes and native CLI sign-in
status. Credential presence/status is separate from a successful agent turn.
The phone never marks a restart complete until it observes a new process epoch.

Explicit update uses the existing verified npm installer and rollback selection.
It can be requested with automatic updates off without changing that preference.
Activation waits for work to finish; managed macOS launch agents can then be
restarted from the phone. Development checkouts are not replaced remotely.

Cache cleanup is restricted to rebuildable repository indexes and obsolete
immutable MCP downloads. The running package, selected package and rollback
package are preserved. Other running package processes are checked before
removal; failed process inspection preserves all packages. Symlinks are not
followed. Installation and cleanup share an exclusive lock. Chats, provider
sessions, projects, pairing and credentials are outside this operation.

Sign-in starts the provider's own CLI: Grok/Codex device authorization, Claude
Code manual browser authorization, or Cursor login. The requesting controller
receives only a bounded HTTPS provider challenge and optional device code.
Claude's returned authorization code goes to that exact CLI's stdin. Challenges
expire, can be cancelled, and are never submitted as chat messages. Tokens stay
in the provider's native credential store. The person completes authorization
on the provider page; receiving a URL alone is not a completed sign-in.

Restarting a provider stops only CLI processes started by this GrantTap process
and verifies a fresh CLI launch. Interrupting an active owned request requires
the explicit interrupt option. It does not restart unrelated desktop sessions
or log anyone out. Subsequent messages start a fresh provider connection.

Requests require the authenticated machine room, an approved controller key,
the observed computer identity for mutations, and a recent timestamp. Retries
with the same request ID return the same operation; changing its meaning is
rejected. Sign-in results go only to the requesting peer, with a short TTL and
without durable mailbox storage.

Regression tests cover controller/room/computer isolation, request idempotency,
native login challenge formats, code ownership/cancellation/expiry, UTF-8
streams, launchd Node PATH recovery and preservation during cache cleanup.

The latest sign-in state is replayed privately when its controller refreshes status.
This restores completion after a phone returns from the browser without starting
another login, resending a prompt, or retaining terminal authorization codes.

MCP 0.8.111 adds provider-update controls for Claude Code, Codex CLI, Grok CLI and Cursor CLI. Each runs its own fixed updater (or its owning npm/Homebrew installer) on the selected computer; desktop Claude can install the latest native CLI. An explicit update probes versions before and after, caches the observed version, and refuses active GrantTap requests for that provider or an active sign-in. Background recovery asks for the original operation ID; it returns the saved private result without running the update again. Older clients can ignore the optional updateSupported capability.

A Codex copy bundled with the desktop app is preserved. Its update action uses
the [official standalone installer](https://learn.chatgpt.com/docs/cli) with
noninteractive input and then resolves the native `~/.local/bin/codex` copy,
including under launchd's stripped PATH. An explicit binary override keeps
priority. Version output retains prerelease suffixes so an alpha is not shown
as a stable release. Regression tests simulate installer output and verify the
original app binary remains unchanged.

MCP 0.8.113 reads installed Grok download versions and the bundled Codex CLI’s
own package manifest without launching either provider. Codex prerelease suffixes
are retained; missing or unsupported manifests remain unknown.
