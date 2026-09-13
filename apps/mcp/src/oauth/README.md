# OAuth

This module owns local MCP OAuth client persistence and token issuance. The OAuth authorization endpoint immediately redirects to `https://granttap.com/connect`; the website reads a short-lived request through the loopback helper, while pairing keys remain on the computer and phone. The local service never renders a user-facing consent page.

License: this module is distributed under the GrantTap Commercial Source License in the repository-root `LICENSE` file.
