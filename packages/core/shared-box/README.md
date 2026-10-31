# Shared NaCl box keys

Repeated device envelopes reuse NaCl's documented `box.before` precomputation.
`box.after` and `box.open.after` produce and read the existing NaCl wire format;
every envelope still uses a fresh random nonce. Both devices' key bytes identify
the cache entry, so key rotation cannot select an older pairing's shared key.

The process-local LRU holds at most 64 keys for 60 seconds of monotonic time.
Expiration is enforced on lookup. Eviction, expiry and explicit transport close
zero the cached key material. Decoded private-key scratch buffers are zeroed on
each lookup; cache identifiers are SHA-256 digests, not raw private keys.

Tests in `tests/` cover direct NaCl interoperability, rotation, authentication,
fresh nonces, bounded derivation and erasure. This module uses the
GrantTap Commercial Source License.
