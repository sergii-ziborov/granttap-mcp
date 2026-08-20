//! Cheap self-heal diagnostics for empty chats / dead monitor.

use crate::config::{
    config_dir, machine_config_path, monitor_log_path, sessions_status_path,
};
use std::fs;
use std::process::Command;

const LAUNCH_AGENT_LABEL: &str = "com.granttap.monitor";

pub fn render_status() -> String {
    let mut lines = Vec::new();
    lines.push(format!("configDir: {}", config_dir().display()));

    let machine = machine_config_path();
    if machine.is_file() {
        match crate::config::load_config(&machine) {
            Ok(cfg) => {
                lines.push(format!(
                    "pairing: present role={} room={} relay={}",
                    cfg.role, cfg.room, cfg.relay_url
                ));
            }
            Err(e) => lines.push(format!("pairing: unreadable ({e})")),
        }
    } else {
        lines.push("pairing: missing (run connect)".into());
    }

    let organization = crate::organization_policy::unix_now()
        .and_then(|now| crate::organization_policy::inspect(&config_dir(), now));
    match organization {
        Ok(Some(policy)) => lines.push(format!(
            "organizationPolicy: verified revision={} epoch={}",
            policy.revision(),
            policy.authorization_epoch()
        )),
        Ok(None) => lines.push("organizationPolicy: unmanaged".into()),
        Err(error) => lines.push(format!("organizationPolicy: blocked ({error})")),
    }

    let plist = launch_agents_dir().join(format!("{LAUNCH_AGENT_LABEL}.plist"));
    if plist.is_file() {
        lines.push(format!("launchAgentPlist: {}", plist.display()));
    } else {
        lines.push("launchAgentPlist: missing".into());
    }

    lines.push(format!("launchAgentLoaded: {}", launch_agent_loaded()));

    let log = monitor_log_path();
    if log.is_file() {
        let meta = fs::metadata(&log).ok();
        let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let tail = fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        lines.push(format!(
            "monitor.log: {} bytes mtime_unix={mtime} tail: {tail}",
            bytes
        ));
    } else {
        lines.push("monitor.log: missing".into());
    }

    let sessions = sessions_status_path();
    if sessions.is_file() {
        let bytes = fs::metadata(&sessions).map(|m| m.len()).unwrap_or(0);
        let preview = fs::read_to_string(&sessions)
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        lines.push(format!("sessions.status: {bytes} bytes preview={preview:?}"));
    } else {
        lines.push("sessions.status: missing (often means monitor never published)".into());
    }

    lines.push(format!("binary: {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into())));
    lines.join("\n")
}

fn launch_agents_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("GRANTTAP_LAUNCH_AGENTS_DIR") {
        return std::path::PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    home.join("Library/LaunchAgents")
}

fn launch_agent_loaded() -> String {
    if std::env::consts::OS != "macos" {
        return "n/a (not macOS)".into();
    }
    let output = Command::new("launchctl")
        .args(["print", &format!("gui/{}/{}", uid(), LAUNCH_AGENT_LABEL)])
        .output();
    match output {
        Ok(out) if out.status.success() => "yes".into(),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("Could not find service") || err.contains("not found") {
                "no".into()
            } else {
                format!("unknown ({})", err.chars().take(80).collect::<String>())
            }
        }
        Err(e) => format!("error ({e})"),
    }
}

fn uid() -> u32 {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}
