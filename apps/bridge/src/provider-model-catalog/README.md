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

MIT License. See [LICENSE](../../../../LICENSE).
