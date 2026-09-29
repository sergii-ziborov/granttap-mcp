# Mac model catalog

Public entry point: [`index.ts`](index.ts). Adds this Mac's fresh native provider
model metadata to both the Mesh list and the selected Mesh. The list reads the
catalog once per request; selected Mesh enrichment preserves it. It shares the
bounded account-scoped reader used by the phone publisher, without scanning
provider conversations or starting a provider session. Missing or expired data
remains explicitly stale. Model descriptions never include provider instructions.

Behavior tests: [`tests/catalog.test.ts`](tests/catalog.test.ts).

MIT License. See [LICENSE](../../../../../LICENSE).
