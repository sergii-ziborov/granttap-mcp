# Recorded Claude capability usage

Public entry point: [`index.ts`](index.ts).

The Claude transcript parser records confirmed MCP and skill observations before
the recent detail cache is trimmed. It keeps at most 20,000 metadata observations
from the last 30 days while parsing, then retains compact execution and period
aggregates keyed to the existing transcript cache. Inputs and result bodies are
not retained by this module. Child transcript aggregates remain attributed to
their parent execution. Missing duration or resource evidence stays unknown.

Tests live in [`tests/recorded-usage.test.ts`](tests/recorded-usage.test.ts).
The repository quality and public package boundaries apply to this module.

## License

This module is covered by the [GrantTap Commercial Source License](../../../../../../../LICENSE).
