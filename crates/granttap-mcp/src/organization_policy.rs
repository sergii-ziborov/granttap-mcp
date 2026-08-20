//! Local verification of enrolled Blindplane organization policy.

use crate::login_receipt;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use blindplane_access::{
    AccessValidationPolicy, CapabilityKind, Decision, TenantPolicy, TrustedIssuer,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuerManifest {
    version: u16,
    tenant_id: String,
    subject_id: String,
    subject_key_id: String,
    issuer_id: String,
    issuer_key_id: String,
    issuer_public_key: String,
    minimum_revision: String,
    minimum_authorization_epoch: String,
    login_issuer_id: String,
    login_issuer_key_id: String,
    login_issuer_public_key: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyState {
    version: u16,
    revision: String,
    authorization_epoch: String,
    policy_hash: String,
}

/// A policy that passed Blindplane signature, trust, subject, time, and replay checks.
pub struct OrganizationPolicy {
    policy: TenantPolicy,
    trusted: TrustedIssuer,
    tenant_id: String,
    subject_id: String,
    minimum_revision: u64,
    minimum_authorization_epoch: u64,
}

impl OrganizationPolicy {
    /// Evaluate one exact default-deny capability at the supplied Unix second.
    pub fn decision(&self, kind: CapabilityKind, name: &str, now: u64) -> Result<Decision, String> {
        self.policy
            .verify(
                &self.trusted,
                &self.tenant_id,
                &self.subject_id,
                now,
                self.minimum_revision,
                self.minimum_authorization_epoch,
            )
            .map(|verified| verified.decision(kind, name))
            .map_err(|error| format!("organization policy verification failed: {error}"))
    }

    /// Accepted monotonic policy revision.
    pub const fn revision(&self) -> u64 {
        self.policy.revision()
    }

    /// Accepted authorization epoch.
    pub const fn authorization_epoch(&self) -> u64 {
        self.policy.authorization_epoch()
    }
}

fn decode_32(value: &str, label: &str) -> Result<[u8; 32], String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("invalid {label}"))?;
    decoded
        .try_into()
        .map_err(|_| format!("invalid {label} length"))
}

fn parse_u64(value: &str, label: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("invalid {label}"))?;
    if parsed == 0 {
        return Err(format!("invalid {label}"));
    }
    Ok(parsed)
}

fn read_regular(path: &Path, maximum_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > maximum_bytes {
        return Err(format!("{} exceeds its size limit", path.display()));
    }
    fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))
}

fn read_state(path: &Path) -> Result<Option<(u64, u64, [u8; 32])>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_regular(path, 4_096)?;
    let state: PolicyState = blazingly_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if state.version != 1 {
        return Err("unsupported policy state version".into());
    }
    Ok(Some((
        parse_u64(&state.revision, "state revision")?,
        parse_u64(&state.authorization_epoch, "state epoch")?,
        decode_32(&state.policy_hash, "state policy hash")?,
    )))
}

fn verify_chain(policy: &TenantPolicy, state: Option<(u64, u64, [u8; 32])>) -> Result<(), String> {
    let Some((revision, epoch, hash)) = state else {
        return Ok(());
    };
    if policy.revision() < revision {
        return Err("stale organization policy revision".into());
    }
    if policy.authorization_epoch() < epoch {
        return Err("revoked organization authorization epoch".into());
    }
    if policy.revision() == revision {
        return (policy.policy_hash() == hash)
            .then_some(())
            .ok_or_else(|| "organization policy changed without a revision".into());
    }
    if policy.revision() != revision + 1 || policy.previous_hash() != hash {
        return Err("organization policy revision chain is incomplete".into());
    }
    Ok(())
}

fn write_state(path: &Path, policy: &TenantPolicy) -> Result<(), String> {
    let state = PolicyState {
        version: 1,
        revision: policy.revision().to_string(),
        authorization_epoch: policy.authorization_epoch().to_string(),
        policy_hash: URL_SAFE_NO_PAD.encode(policy.policy_hash()),
    };
    let body = blazingly_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        file.write_all(&body).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn load_policy(
    config_root: &Path,
    now: u64,
    persist_accepted_state: bool,
) -> Result<Option<OrganizationPolicy>, String> {
    let managed = config_root.join("managed");
    let issuer_path = managed.join("issuer.json");
    let metadata = match fs::symlink_metadata(&managed) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_dir() {
        return Err("managed path is not a directory".into());
    }
    let manifest: IssuerManifest = blazingly_json::from_slice(&read_regular(&issuer_path, 16_384)?)
        .map_err(|error| format!("parse issuer manifest: {error}"))?;
    if manifest.version != 2 {
        return Err("unsupported issuer manifest version".into());
    }
    let issuer_public_key = decode_32(&manifest.issuer_public_key, "issuer public key")?;
    let trusted = TrustedIssuer::from_public_key(&manifest.issuer_id, issuer_public_key)
        .map_err(|error| error.to_string())?;
    if trusted.key_id() != decode_32(&manifest.issuer_key_id, "issuer key id")? {
        return Err("issuer key id does not match its public key".into());
    }
    let policy = TenantPolicy::decode(
        &read_regular(&managed.join("organization-policy.bin"), 262_144)?,
        &AccessValidationPolicy::default(),
    )
    .map_err(|error| format!("decode organization policy: {error}"))?;
    if policy.subject_key_id() != decode_32(&manifest.subject_key_id, "subject key id")? {
        return Err("organization policy targets another subject key".into());
    }
    let minimum_revision = parse_u64(&manifest.minimum_revision, "minimum revision")?;
    let minimum_authorization_epoch = parse_u64(
        &manifest.minimum_authorization_epoch,
        "minimum authorization epoch",
    )?;
    let login_issuer_key_id = decode_32(&manifest.login_issuer_key_id, "login issuer key id")?;
    let login_issuer_public_key =
        decode_32(&manifest.login_issuer_public_key, "login issuer public key")?;
    if login_receipt::issuer_key_id(&login_issuer_public_key) != login_issuer_key_id {
        return Err("login issuer key id does not match its public key".into());
    }
    login_receipt::verify(
        &managed.join("login.receipt"),
        &manifest.tenant_id,
        &manifest.subject_id,
        &decode_32(&manifest.subject_key_id, "subject key id")?,
        &manifest.login_issuer_id,
        &login_issuer_key_id,
        &login_issuer_public_key,
        minimum_authorization_epoch,
        now,
    )?;
    policy
        .verify(
            &trusted,
            &manifest.tenant_id,
            &manifest.subject_id,
            now,
            minimum_revision,
            minimum_authorization_epoch,
        )
        .map_err(|error| format!("verify organization policy: {error}"))?;
    let state_path = managed.join("policy-state.json");
    let state = read_state(&state_path)?;
    verify_chain(&policy, state)?;
    if persist_accepted_state {
        write_state(&state_path, &policy)?;
    }
    Ok(Some(OrganizationPolicy {
        policy,
        trusted,
        tenant_id: manifest.tenant_id,
        subject_id: manifest.subject_id,
        minimum_revision,
        minimum_authorization_epoch,
    }))
}

/// Load and persist an optional accepted policy for an enforcement path.
pub fn load(config_root: &Path, now: u64) -> Result<Option<OrganizationPolicy>, String> {
    load_policy(config_root, now, true)
}

/// Verify policy status without mutating accepted state.
pub fn inspect(config_root: &Path, now: u64) -> Result<Option<OrganizationPolicy>, String> {
    load_policy(config_root, now, false)
}

/// Current Unix second for CLI status and hook callers.
pub fn unix_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| error.to_string())
}
