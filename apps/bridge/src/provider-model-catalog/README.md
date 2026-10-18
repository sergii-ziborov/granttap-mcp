# Provider model catalog

Public entry point: [`index.ts`](index.ts). `readCodexModelCatalog` projects the
installed Codex account's visible model-picker metadata from `models_cache.json`.
It reads fresh data each catalog cycle so new models do not require a GrantTap
release. `CODEX_HOME` and GrantTap's existing Codex directory overrides are honored.

Hidden/internal models are excluded. Labels, descriptions, ordering and the
provider's fetch timestamp are preserved. Prompt instructions, account identity
and the rest of the native payload never cross the wire. Reads are bounded to
2 MB and 64 model rows. Cache data older than 24 hours, malformed data, and
future timestamps beyond the clock allowance remain unavailable/stale. GrantTap
does not authenticate a provider or start an agent to discover models.

Mesh snapshots replace Codex's historical observed model list when fresh native
metadata exists. Other providers retain observed evidence; observation alone
does not establish current account availability. The Apple composer keeps Claude
CLI aliases as aliases, whose resolved versions remain the provider's choice.

Behavior tests: [`tests/catalog.test.ts`](tests/catalog.test.ts).

GrantTap Commercial Source License. See [LICENSE](../../../../LICENSE).

## All four providers

`readProviderModelCatalog` is the shared endpoint entry point. Fresh Codex
app-server picker metadata takes precedence over its disk cache. Cursor's native
`models` and Grok's native `models` commands supply exact account model IDs;
listing runs without a prompt, and failed/signed-out catalogs advertise nothing.
The wire allows up to 256 models so Cursor's parameter variants are not silently
cut to 64. Claude's supported CLI aliases remain aliases rather than a frozen
list of version numbers. Client model choices use the existing resume flags.

Account percentages travel separately as optional `accountUsage` observations.
See [provider account status](../provider-account-status/README.md).

## Grok Build details and order

`grok models` decides which Grok models exist. Grok Build's own account catalog
(`models_cache.json` in its home, at most 24 hours old, 2 MB) only adds display
names, descriptions and the reasoning levels each listed model accepts
(`supportedEfforts`, e.g. `low…xhigh`); identity, endpoints, keys and headers
are never read into a row. When the listing could not run at all (timeout or a
crash) and Grok Build is installed and signed in, that fresh catalog stands in
for it with its own fetch time; a signed-out listing advertises nothing.
Cursor and Grok rows carry their CLI order as `priority`, so the phone shows
them in the provider's order. The Grok binary is resolved like its turns
(`GRANTTAP_GROK_BIN`, then `PATH`, then `~/.grok/bin/grok`), so a launchd PATH
without Grok's installer directory no longer hides it.

Claude Code has no listing command. Its picker keeps the CLI's documented aliases
(`opus`, `sonnet`, `haiku`, `fable`); `--model` also accepts full names, which
the phone does not invent. Tests: [`tests/grok-catalog.test.ts`](tests/grok-catalog.test.ts).
