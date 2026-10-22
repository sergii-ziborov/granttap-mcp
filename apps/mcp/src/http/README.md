# Local HTTP service

`http-server.ts` is the public entry point for the loopback MCP, OAuth and native
desktop service. Listener addresses must be loopback addresses.

`GET /healthz` and `GET /desktop/status` return bounded observations without
starting provider CLIs or changing provider configuration. Desktop discovery
uses the latest available hook observations; an unconfirmed status stays
unconfirmed. Opening the Mac client does not wait for a Codex subprocess.

Authenticated native operations use the desktop bridge. Pairing material and
credentials are excluded from public status responses.
## License

Licensed under the GrantTap Commercial Source License. See LICENSE and NOTICE.
