# OpenAI directory package

Public entry point: `index.mjs`. This assembles the same portable plugin for
ChatGPT and Codex's universal directory. It does not submit or publish a listing.
The existing Git marketplace remains a separate distribution channel.
The plugin and local runtime use the GrantTap Commercial Source License.
The iPhone and Apple Watch app and hosted service have separate terms.

Prepare the exact published `granttap-mcp` npm version declared by the repository
in an isolated directory. Verify npm integrity, extract its tarball and install
production dependencies with lifecycle scripts disabled. Then run:
Include the matching published esbuild optional binaries for each intended
desktop OS and CPU; copying only this machine's optional dependency breaks
installation on other architectures. Verify every added tarball's npm integrity.

```sh
node scripts/openai-submission/index.mjs /absolute/empty/plugin /absolute/prepared/runtime
cd /absolute/empty/plugin
zip -q -r -D /absolute/output/GrantTap-OpenAI.zip .
```

The package includes the production runtime and dependencies; it never downloads
or installs a provider CLI. Its server is stdio and requires Node.js 22.13 or
newer on the user's desktop. It includes no lifecycle hook configuration, app
references, developer credentials, private pairing state or internal evidence.
Dependency source maps, type declarations and `.bin` links are excluded. Before
upload, verify the ZIP is at most 100 MB with at most 5,000 entries, contains no
symlinks, unsafe paths or normalization collisions, and extracts below 512 MiB.
Durable agent monitoring still requires the GrantTap helper; the plugin does not
silently perform system setup merely because a host loads it.

## Review prerequisites

As of October 25, 2026, local MCP submissions require an approved OpenAI partner
and an allowlisted submitting organization. A verified publisher with submission
access uploads this ZIP through the desktop-only process. Publication follows
OpenAI review. An approved local package receives a Desktop only badge; this is
not a remote MCP integration for ChatGPT web or mobile.

An ordinary remote submission instead requires a stable public HTTPS MCP endpoint
and supported authentication. GrantTap currently binds its MCP to loopback; its
ciphertext relay is not such an endpoint. Do not substitute the relay URL or
declare the local service unauthenticated to bypass these prerequisites.

Official requirements:

- https://developers.openai.com/plugins/deploy/desktop-only
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/build/plugins

Tests are in `tests/marketplace/openai-submission/`. Before publishing source,
run the repository quality gate and verify the assembled ZIP's actual stdio
initialization, tool discovery and private-state boundaries in an isolated home.
