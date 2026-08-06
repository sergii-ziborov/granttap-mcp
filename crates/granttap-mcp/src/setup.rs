//! Hook + LaunchAgent registration pointing at this binary (not Node).

use crate::config::config_dir;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

pub struct InstallResult {
    pub status: &'static str,
    pub detail: String,
}

pub fn run_setup() -> String {
    let claude = install_claude_hook();
    let codex = install_codex_hook();
    let monitor = install_monitor_helper();
    format!(
        "Claude: {} ({})\nCodex: {} ({})\nBackground task sync: {} ({})",
        claude.status, claude.detail, codex.status, codex.detail, monitor.status, monitor.detail
    )
}

fn binary_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("granttap-mcp"))
}

fn hook_command(agent: &str) -> String {
    format!("\"{}\" hook {agent}", binary_path().display())
}

pub fn install_monitor_helper() -> InstallResult {
    if std::env::consts::OS != "macos" {
        return InstallResult {
            status: "manual",
            detail: "background task sync currently requires macOS".into(),
        };
    }
    let agents_dir = std::env::var("GRANTTAP_LAUNCH_AGENTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            home.join("Library/LaunchAgents")
        });
    let label = "com.granttap.monitor";
    let path = agents_dir.join(format!("{label}.plist"));
    let log_path = config_dir().join("monitor.log");
    let exe = binary_path();
    let cwd = std::env::var("GRANTTAP_MONITOR_CWD")
        .unwrap_or_else(|_| std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| ".".into()));
    let path_env = std::env::var("PATH").unwrap_or_else(|_| {
        "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()
    });
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>monitor</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>{}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        xml(&exe.display().to_string()),
        xml(&path_env),
        xml(&cwd),
        xml(&log_path.display().to_string()),
    );
    let _ = fs::create_dir_all(&agents_dir);
    let _ = fs::create_dir_all(config_dir());
    let already = path.is_file()
        && fs::read_to_string(&path).map(|s| s == plist).unwrap_or(false);
    if let Err(e) = fs::write(&path, &plist) {
        return InstallResult {
            status: "manual",
            detail: format!("{}: {e}", path.display()),
        };
    }
    if std::env::var("GRANTTAP_SKIP_LAUNCHCTL").ok().as_deref() == Some("1") {
        return InstallResult {
            status: if already { "already" } else { "installed" },
            detail: path.display().to_string(),
        };
    }
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "501".into());
    let domain = format!("gui/{uid}");
    let _ = Command::new("launchctl")
        .args(["bootout", &domain, &path.display().to_string()])
        .status();
    let loaded = Command::new("launchctl")
        .args(["bootstrap", &domain, &path.display().to_string()])
        .output();
    match loaded {
        Ok(out) if out.status.success() => InstallResult {
            status: if already { "already" } else { "installed" },
            detail: path.display().to_string(),
        },
        Ok(out) => {
            let detail = String::from_utf8_lossy(&out.stderr);
            InstallResult {
                status: "manual",
                detail: format!("{}: {}", path.display(), detail.trim()),
            }
        }
        Err(e) => InstallResult {
            status: "manual",
            detail: format!("{}: {e}", path.display()),
        },
    }
}

fn install_claude_hook() -> InstallResult {
    let dir = std::env::var("GRANTTAP_CLAUDE_DIR")
        .or_else(|_| std::env::var("NODVOX_CLAUDE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            home.join(".claude")
        });
    let path = dir.join("settings.json");
    let _ = fs::create_dir_all(&dir);
    let current = hook_command("claude");
    let mut settings: blazingly_json::Value = if path.is_file() {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|s| blazingly_json::from_str(&s).ok())
        {
            Some(v) => v,
            None => {
                return InstallResult {
                    status: "manual",
                    detail: format!("{} — unreadable JSON", path.display()),
                };
            }
        }
    } else {
        blazingly_json::json!({})
    };

    // Minimal: if granttap already mentioned, report already; else append a PreToolUse entry.
    let serialized = blazingly_json::to_string(&settings).unwrap_or_default();
    if serialized.contains("granttap") && serialized.contains(&current) {
        return InstallResult {
            status: "already",
            detail: path.display().to_string(),
        };
    }
    let entry = blazingly_json::json!({
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
        "hooks": [{ "type": "command", "command": current, "timeout": 120 }]
    });
    if let Some(obj) = settings.as_object_mut() {
        let hooks = obj
            .entry("hooks")
            .or_insert_with(|| blazingly_json::json!({}));
        if let Some(hooks_obj) = hooks.as_object_mut() {
            let pre = hooks_obj
                .entry("PreToolUse")
                .or_insert_with(|| blazingly_json::json!([]));
            if let Some(arr) = pre.as_array_mut() {
                arr.push(entry);
            }
        }
    }
    backup_once(&path);
    match blazingly_json::to_vec_pretty(&settings) {
        Ok(body) => {
            let mut out = body;
            out.push(b'\n');
            if let Err(e) = fs::write(&path, out) {
                return InstallResult {
                    status: "manual",
                    detail: format!("{}: {e}", path.display()),
                };
            }
            InstallResult {
                status: "installed",
                detail: path.display().to_string(),
            }
        }
        Err(e) => InstallResult {
            status: "manual",
            detail: e.to_string(),
        },
    }
}

fn install_codex_hook() -> InstallResult {
    let dir = std::env::var("GRANTTAP_CODEX_DIR")
        .or_else(|_| std::env::var("NODVOX_CODEX_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            home.join(".codex")
        });
    let path = dir.join("config.toml");
    let _ = fs::create_dir_all(&dir);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let current = hook_command("codex");
    if existing.contains("granttap") && existing.contains(&current) {
        return InstallResult {
            status: "already",
            detail: path.display().to_string(),
        };
    }
    if existing.contains("granttap") {
        return InstallResult {
            status: "manual",
            detail: format!(
                "{} already has a granttap hook; update command to {current} manually",
                path.display()
            ),
        };
    }
    let mut out = existing;
    if !out.contains("[features]") {
        out.push_str("\n[features]\nhooks = true\n");
    } else if !out.contains("hooks = true") {
        out.push_str("hooks = true\n");
    }
    out.push_str(&format!(
        "\n# granttap — approvals from your phone/watch\n[[hooks.PermissionRequest]]\nmatcher = \".*\"\n[[hooks.PermissionRequest.hooks]]\ntype = \"command\"\ncommand = '{current}'\ntimeout = 120\n"
    ));
    backup_once(&path);
    if let Err(e) = fs::write(&path, out) {
        return InstallResult {
            status: "manual",
            detail: format!("{}: {e}", path.display()),
        };
    }
    InstallResult {
        status: "installed",
        detail: path.display().to_string(),
    }
}

fn backup_once(path: &std::path::Path) {
    if !path.is_file() {
        return;
    }
    let bak = PathBuf::from(format!("{}.bak-granttap", path.display()));
    if !bak.exists() {
        let _ = fs::copy(path, bak);
    }
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
