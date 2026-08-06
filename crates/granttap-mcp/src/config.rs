//! Machine pairing config under `~/.granttap`.

use crate::crypto::{generate_key_pair, random_id};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_RELAY: &str = "wss://granttap-relay.sergii-ziborov.workers.dev";
pub const PAIRING_CODE_TTL_MINUTES: u64 = 15;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerConfig {
    pub relay_url: String,
    pub room: String,
    pub role: String,
    pub device_name: String,
    pub sender_id: String,
    pub my_public_key: String,
    pub my_secret_key: String,
    pub peer_public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_auth: Option<String>,
}

pub fn config_dir() -> PathBuf {
    if let Ok(overridden) = std::env::var("GRANTTAP_CONFIG_DIR")
        .or_else(|_| std::env::var("NODVOX_CONFIG_DIR"))
    {
        return PathBuf::from(overridden);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let current = home.join(".granttap");
    let legacy = home.join(".nodvox");
    if !current.exists() && legacy.exists() {
        return legacy;
    }
    current
}

pub fn machine_config_path() -> PathBuf {
    config_dir().join("machine.json")
}

pub fn phone_pairing_path() -> PathBuf {
    config_dir().join("phone.pairing.json")
}

pub fn monitor_log_path() -> PathBuf {
    config_dir().join("monitor.log")
}

pub fn sessions_status_path() -> PathBuf {
    config_dir().join("sessions.status")
}

pub fn normalize_relay_url(value: &str) -> Result<String, String> {
    let url = value.trim().trim_end_matches('/');
    if !(url.starts_with("wss://") || url.starts_with("ws://")) {
        return Err("relay URL must use wss:// (ws:// is allowed for local development)".into());
    }
    if url.starts_with("ws://") {
        let host = url.trim_start_matches("ws://").split('/').next().unwrap_or("");
        let host = host.split(':').next().unwrap_or(host);
        let loopback = host == "localhost"
            || host.ends_with(".localhost")
            || host == "[::1]"
            || host == "::1"
            || host.starts_with("127.");
        if !loopback {
            return Err("unencrypted ws:// is allowed only for a loopback development relay".into());
        }
    }
    Ok(url.to_string())
}

pub fn load_config(path: &Path) -> Result<PeerConfig, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    blazingly_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn save_config(path: &Path, cfg: &PeerConfig) -> Result<(), String> {
    fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
    let body = blazingly_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn create_pairing(relay_url: &str) -> Result<(PeerConfig, PeerConfig), String> {
    let relay_url = normalize_relay_url(relay_url)?;
    let machine = generate_key_pair()?;
    let phone = generate_key_pair()?;
    let room = random_id(16)?;
    let push_auth = random_id(32)?;
    let device_name = hostname();
    let machine_cfg = PeerConfig {
        relay_url: relay_url.clone(),
        room: room.clone(),
        role: "machine".into(),
        device_name,
        sender_id: random_id(4)?,
        my_public_key: machine.public_key.clone(),
        my_secret_key: machine.secret_key,
        peer_public_key: phone.public_key.clone(),
        push_auth: Some(push_auth.clone()),
    };
    let phone_cfg = PeerConfig {
        relay_url,
        room,
        role: "phone".into(),
        device_name: "phone".into(),
        sender_id: "phone".into(),
        my_public_key: phone.public_key,
        my_secret_key: phone.secret_key,
        peer_public_key: machine.public_key,
        push_auth: Some(push_auth),
    };
    Ok((machine_cfg, phone_cfg))
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| {
            fs::read_to_string("/etc/hostname")
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| "machine".into())
        })
}
