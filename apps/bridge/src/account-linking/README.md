# Account linking

GrantTap account login is independent from encrypted phone pairing and coding
provider credentials. Personal/Team login is optional; Enterprise login returns
a short-lived, device-bound signed receipt required by managed policy.

The machine uses an Ed25519 device key plus PKCE. Protected secrets live in the
macOS Keychain. The displayed QR contains only the HTTPS browser verification
URL and user code, never the device code, verifier, access token, pairing key, or
provider credential. Completion is a separate bounded call so an agent tool
does not wait indefinitely for a scan.

The Enterprise receipt is verified against a dedicated GrantTap Control issuer
in managed issuer manifest v2 before installation. Its signing key is separate
from the Blindplane organization-policy issuer. Logout removes account tokens
and the login receipt while leaving phone pairing untouched.
