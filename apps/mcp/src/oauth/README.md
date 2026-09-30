# OAuth

This module owns local MCP OAuth client persistence and token issuance. `/authorize` returns the 302 to `https://granttap.com/connect#request=` immediately. Publishing the public snapshot to the website happens after that response — a hung site must not leave a blank `127.0.0.1:17342/authorize` tab. A Mac that is already paired still opens `/connect` so Approve, Reconnect, and Add another stay available. A fresh account passkey assertion on that page can approve the MCP client even before a phone is paired; the QR path stays independent. The site reports the verified passkey decision, and the local provider issues only its own OAuth token for this client and resource. The website never fetches loopback. Pairing keys remain on the computer and phone. The local service never renders a user-facing consent page. Launchctl wakes of the monitor stay off the `/authorize` thread.

License: this module is distributed under the MIT License in the repository-root `LICENSE` file.
