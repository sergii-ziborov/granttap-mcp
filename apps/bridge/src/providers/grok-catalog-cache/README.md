# Grok catalog cache

Public entry: `GrokCatalogCache`. Cache only the parsed native inputs belonging
to the current admitted scan. Model-context files and visible update streams
have separate fingerprints, so streaming text does not decode an unchanged
context again. A complete export bypasses this catalog cache.

First-party code is under the GrantTap Commercial Source License.
