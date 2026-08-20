//! GrantTap MCP library modules (also used by the `granttap-mcp` binary).

pub mod config;
pub mod crypto;
pub mod http;
pub mod nacl_salsa;
pub mod organization_policy;
pub mod pairing;
pub mod relay;
pub mod setup;
pub mod status;
pub mod tools;
pub mod websocket;

#[cfg(target_os = "macos")]
pub mod tls_macos;
