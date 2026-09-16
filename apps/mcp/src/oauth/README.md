# OAuth

This module owns local MCP OAuth client persistence and token issuance. The OAuth authorization endpoint publishes a public snapshot to `https://granttap.com` and redirects the browser there. The website never fetches loopback. Pairing keys remain on the computer and phone. The local service never renders a user-facing consent page.

License: this module is distributed under the MIT License in the repository-root `LICENSE` file.
