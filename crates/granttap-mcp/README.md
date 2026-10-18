# granttap-mcp (Rust)

Tokio-free GrantTap MCP binary for Cursor / Claude / Codex.

## Scope

Phone/approval channel only:

| Tool | Purpose |
|------|---------|
| `connect` | One-time pairing URI (QR PNG is a known gap vs Node) |
| `notify` | Fire-and-forget status to phone |
| `ask` | Open question, wait for reply |
| `ask_yes_no` | Yes/No approval, wait for tap |
| `setup` | Install hooks + LaunchAgent plist pointing at **this binary** |
| `status` | Self-heal: pairing, organization policy, LaunchAgent, monitor.log / sessions |

Not in scope: Weavatrix, git intelligence, repo search.

## Why Rust

Node LaunchAgent failures often come from a missing `node` on `PATH`. A single signed `granttap-mcp` path is easier for Accessibility + `launchctl`.

## Build

```bash
cd /Users/serhiirihgt/dev/granttap-mcp
cargo build -p granttap-mcp --release
```

## Cursor `mcp.json`

```json
{
  "mcpServers": {
    "granttap": {
      "command": "/Users/serhiirihgt/dev/granttap-mcp/target/release/granttap-mcp",
      "args": []
    }
  }
}
```

## Crate map

| Crate | Role |
|-------|------|
| `mcport` | MCP stdio runtime (controlled/concurrent for long `ask`) |
| `blazingly-json` | JSON (via mcport + direct) |
| `blindplane-crypto` | X25519, Poly1305, OS RNG; NaCl box/salsa layered in this crate for tweetnacl wire compat |
| `blindplane-access` | Pinned issuer, signed tenant policy, revision/epoch, and default-deny decisions |
| `std` | TCP, threads, files, `launchctl` |

## Honest gaps vs Node MCP

- PNG QR for `connect` (returns text URI / manual token)
- Shell-gate dedupe + Cursor Accessibility Allow-click (Node-only for now)
- Monitor process itself stays Node until ported; Rust `setup` can point LaunchAgent at this binary's `monitor` subcommand once implemented
- Policy verification is live in Rust `status`; Rust hook enforcement waits for the hook subcommand port, while the product bridge already enforces the same binary format
- `wss://` uses macOS Secure Transport (`tls_macos`); non-macOS needs a TLS seam later

## License

This unpublished crate is distributed under the GrantTap Commercial Source License
inherited from the workspace `LICENSE` file.
