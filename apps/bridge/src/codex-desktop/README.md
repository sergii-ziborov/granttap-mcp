# Codex desktop delivery

Public entry: `deliverToCodexDesktop` in `index.ts`. A paired controller's follow-up
goes to the native owner of the existing conversation, including between turns.
Starting a second `codex exec resume` against that owner's thread would conflict
with its single writer. New Tasks continue to use the provider's CLI creation path.

The local desktop coordination protocol is versioned and differs from the public
app-server WebSocket transport. This adapter implements its framing independently;
no desktop application source is bundled. The existing socket must be private,
owned by the current user, and inside the configured Codex home. Nothing creates,
replaces, or restarts the native router. Windows has no tested desktop socket path
and keeps the CLI path.

The native owner inherits its workspace and approval settings. Explicit per-Task
sandbox settings and model/effort are carried with the turn. Disabled MCP settings
that cannot be enforced through the owner are refused. Protocol errors or an
unconfirmed submission never fall back to a second writer. Only a missing socket
or an explicit owner-not-found response permits headless resume.

The original message ID is carried into Codex. A private, cross-process receipt
records a hash of the intent before dispatch and native turn ID after acceptance.
An uncertain or crashed dispatch is not replayed. A native receipt produces no
synthetic assistant reply or completed-run digest; the existing transcript carries
the actual work. Pause sends the user's stop request to the same owner. Document
attachments remain in private staging for up to a day after admission; the monitor
removes expired stages. Image-only stages are removed once native admission has
consumed them. Tests exercise native delivery, framing, socket trust, durable
deduplication, and refusal without launching the CLI.

License: GrantTap Commercial Source License in the repository-root `LICENSE`.

Document staging for a native-only question keeps the file note inside its
original answer envelope. The host's native question and all paired controllers
therefore observe the same question item as answered; document paths remain
available to the admitted turn. Ordinary chat text is unchanged.

The bounded native admission deadline leaves time for the installed router’s
ten-second owner discovery window. A five-second client cap otherwise reports
healthy CLI conversations unavailable before discovery can finish. Missing-owner
confirmation preserves CLI continuation; uncertain dispatch remains unreplayed.
