//! One-time secure mailbox pairing (connect tool).

use crate::config::{
    create_pairing, machine_config_path, normalize_relay_url, phone_pairing_path, save_config,
    DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES,
};
use crate::crypto::{generate_transfer_key, random_id, seal_with_transfer_key};
use crate::http::put_json;
use blazingly_json::json;
use std::time::Duration;

pub struct OneTimePairing {
    pub http_base: String,
    pub qr_payload: String,
    pub manual_token: String,
    pub reused_existing: bool,
}

pub fn create_one_time_pairing(relay_url: Option<&str>) -> Result<OneTimePairing, String> {
    let env_relay = std::env::var("GRANTTAP_RELAY_URL")
        .or_else(|_| std::env::var("NODVOX_RELAY_URL"))
        .ok();
    let relay = normalize_relay_url(
        relay_url
            .or(env_relay.as_deref())
            .unwrap_or(DEFAULT_RELAY),
    )?;

    // Re-park existing pairing without rotating keys when machine.json already works.
    if let Ok(existing) = crate::config::load_config(&machine_config_path()) {
        if existing.relay_url == relay {
            if let Ok(phone) = crate::config::load_config(&phone_pairing_path()) {
                return park_phone_half(&relay, &phone, true);
            }
        }
    }

    let (machine_cfg, phone_cfg) = create_pairing(&relay)?;
    let parked = park_phone_half(&relay, &phone_cfg, false)?;
    save_config(&machine_config_path(), &machine_cfg)?;
    save_config(&phone_pairing_path(), &phone_cfg)?;
    let _ = crate::setup::install_monitor_helper();
    Ok(parked)
}

fn park_phone_half(
    relay: &str,
    phone_cfg: &crate::config::PeerConfig,
    reused_existing: bool,
) -> Result<OneTimePairing, String> {
    let mailbox_id = random_id(16)?;
    let transfer_key = generate_transfer_key()?;
    let phone_val = blazingly_json::to_value(phone_cfg).map_err(|e| e.to_string())?;
    let (nonce, boxed) = seal_with_transfer_key(&phone_val, &transfer_key)?;
    let body = blazingly_json::to_string(&json!({ "nonce": nonce, "box": boxed }))
        .map_err(|e| e.to_string())?;
    let http_base = relay_http_base(relay);
    let status = put_json(
        &format!("{http_base}/pair/{mailbox_id}"),
        &body,
        Duration::from_secs(10),
    )?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "The GrantTap relay rejected pairing with HTTP {status}."
        ));
    }
    let qr_payload = one_time_pairing_uri(relay, &mailbox_id, &transfer_key);
    Ok(OneTimePairing {
        http_base,
        qr_payload,
        manual_token: format!("{mailbox_id}.{transfer_key}"),
        reused_existing,
    })
}

pub fn relay_http_base(relay_url: &str) -> String {
    let mut base = relay_url.to_string();
    if let Some(rest) = base.strip_prefix("wss://") {
        base = format!("https://{rest}");
    } else if let Some(rest) = base.strip_prefix("ws://") {
        base = format!("http://{rest}");
    }
    base.trim_end_matches('/').to_string()
}

pub fn one_time_pairing_uri(relay_url: &str, mailbox_id: &str, transfer_key: &str) -> String {
    format!(
        "granttap://pair-v2?v=2&u={}&m={mailbox_id}&k={transfer_key}",
        urlencoding_minimal(&relay_http_base(relay_url)),
    )
}

fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn connect_text(pairing: &OneTimePairing) -> String {
    let header = if pairing.reused_existing {
        "Re-parked your existing GrantTap pairing (keys were not rotated). Scan or paste below on iPhone."
    } else {
        "Scan this QR with GrantTap on iPhone to pair this computer."
    };
    format!(
        "{header}\nRelay: {}\nSecure mailbox URI (scan QR, or paste in Pair GrantTap):\n{}\nManual secure token (mailbox.key): {}\nThe encrypted mailbox is single-use and expires after {} minutes.\nThe relay receives only a random mailbox id and ciphertext; the transfer key stays in this user-only QR/token.\n(Note: Rust MCP returns the URI as text; PNG QR is not generated yet.)",
        pairing.http_base,
        pairing.qr_payload,
        pairing.manual_token,
        PAIRING_CODE_TTL_MINUTES
    )
}
