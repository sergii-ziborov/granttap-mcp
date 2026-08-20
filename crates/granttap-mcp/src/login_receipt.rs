//! Offline verification of the device-bound Enterprise login receipt.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use blindplane_crypto::{verify_strict, Sha256};
use serde::Deserialize;
use std::fs;
use std::path::Path;

const KEY_ID_DOMAIN: &[u8] = b"granttap/control/login-issuer-key-id/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    kid: String,
    typ: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    version: u16,
    tenant_id: String,
    subject_id: String,
    subject_key_id: String,
    user_id: String,
    session_id: String,
    authenticated_at: u64,
    expires_at: u64,
    authorization_epoch: String,
    issuer_id: String,
}

fn decode<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("invalid {label}"))?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(format!("non-canonical {label}"));
    }
    decoded
        .try_into()
        .map_err(|_| format!("invalid {label} length"))
}

/// Domain-separated identifier for the independent Control login issuer.
pub fn issuer_key_id(public_key: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(&(KEY_ID_DOMAIN.len() as u32).to_be_bytes());
    hash.update(KEY_ID_DOMAIN);
    hash.update(public_key);
    hash.finalize()
}

/// Verify one bounded compact Ed25519 receipt against the pinned endpoint.
#[allow(clippy::too_many_arguments)]
pub fn verify(
    path: &Path,
    tenant_id: &str,
    subject_id: &str,
    subject_key_id: &[u8; 32],
    issuer_id: &str,
    issuer_key_id: &[u8; 32],
    issuer_public_key: &[u8; 32],
    minimum_epoch: u64,
    now: u64,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("enterprise login required: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() > 16_384 {
        return Err("safe Enterprise login receipt required".into());
    }
    let compact = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if compact.len() > 16_384 || !compact.is_ascii() {
        return Err("bounded ASCII login receipt required".into());
    }
    let parts: Vec<_> = compact.split('.').collect();
    if parts.len() != 3 {
        return Err("compact login receipt required".into());
    }
    let header_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| "invalid login header")?;
    let header: Header =
        blazingly_json::from_slice(&header_bytes).map_err(|error| error.to_string())?;
    if header.alg != "EdDSA"
        || header.typ != "GTLOGIN"
        || header.kid != URL_SAFE_NO_PAD.encode(issuer_key_id)
    {
        return Err("untrusted login receipt header".into());
    }
    let signature = decode::<64>(parts[2], "login signature")?;
    verify_strict(
        issuer_public_key,
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &signature,
    )
    .map_err(|_| "invalid login receipt signature".to_string())?;
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "invalid login payload")?;
    let payload: Payload =
        blazingly_json::from_slice(&payload_bytes).map_err(|error| error.to_string())?;
    let receipt_subject = decode::<32>(&payload.subject_key_id, "login subject key")?;
    if payload.version != 1
        || payload.tenant_id != tenant_id
        || payload.subject_id != subject_id
        || payload.issuer_id != issuer_id
        || receipt_subject != *subject_key_id
    {
        return Err("login receipt targets another endpoint".into());
    }
    if payload.user_id.is_empty()
        || payload.user_id.len() > 255
        || payload.session_id.is_empty()
        || payload.session_id.len() > 255
    {
        return Err("bounded login principal required".into());
    }
    if payload.authenticated_at > now || payload.expires_at <= now {
        return Err("Enterprise login is expired".into());
    }
    let epoch = payload
        .authorization_epoch
        .parse::<u64>()
        .map_err(|_| "invalid login epoch")?;
    if epoch < minimum_epoch {
        return Err("Enterprise login is revoked".into());
    }
    Ok(())
}
