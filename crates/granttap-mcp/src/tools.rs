//! MCP tool surface: connect / notify / ask / ask_yes_no / setup / status.

use crate::config::{load_config, machine_config_path};
use crate::crypto::random_id;
use crate::pairing::{connect_text, create_one_time_pairing};
use crate::relay::RelayClient;
use crate::setup::run_setup;
use crate::status::render_status;
use blazingly_json::{json, Value};
use mcport::{ConcurrentMcpServer, RuntimeConfig, ToolReply};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const NOT_PAIRED: &str =
    "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";

fn ask_timeout() -> Duration {
    let ms = std::env::var("GRANTTAP_ASK_TIMEOUT_MS")
        .or_else(|_| std::env::var("NODVOX_ASK_TIMEOUT_MS"))
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(180_000_u64);
    Duration::from_millis(ms)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct App {
    client: Mutex<Option<RelayClient>>,
}

impl App {
    fn relay(&self) -> Result<RelayClient, String> {
        let mut g = self.client.lock().map_err(|e| e.to_string())?;
        if let Some(c) = g.as_ref() {
            return Ok(c.clone());
        }
        let cfg = load_config(&machine_config_path())?;
        let client = RelayClient::new(cfg);
        client.connect(Duration::from_secs(30))?;
        *g = Some(client.clone());
        Ok(client)
    }

    fn reset(&self) {
        if let Ok(mut g) = self.client.lock() {
            if let Some(c) = g.take() {
                c.close();
            }
        }
    }
}

/// Build and serve the GrantTap MCP stdio server.
pub fn serve() -> std::io::Result<()> {
    let app = Arc::new(App {
        client: Mutex::new(None),
    });

    let schema_message = json!({
        "type": "object",
        "properties": {
            "message": { "type": "string", "minLength": 1, "maxLength": 8000 }
        },
        "required": ["message"],
        "additionalProperties": false
    });
    let schema_question = json!({
        "type": "object",
        "properties": {
            "question": { "type": "string", "minLength": 1, "maxLength": 8000 }
        },
        "required": ["question"],
        "additionalProperties": false
    });
    let schema_connect = json!({
        "type": "object",
        "properties": {
            "relayUrl": { "type": "string", "maxLength": 2048 }
        },
        "additionalProperties": false
    });
    let schema_empty = json!({ "type": "object", "additionalProperties": false });

    let a = Arc::clone(&app);
    let b = Arc::clone(&app);
    let c = Arc::clone(&app);
    let d = Arc::clone(&app);

    ConcurrentMcpServer::new("granttap", env!("CARGO_PKG_VERSION"))
        .instructions("GrantTap phone/watch approvals. Core tools only — not a coding intelligence server.")
        .tool(
            "connect",
            "Pair this computer with the GrantTap iPhone app. Use when the user asks to connect, pair, onboard, or show a pairing QR. Returns a one-time pairing URI in chat.",
            schema_connect,
            move |_ctx, args| match create_one_time_pairing(str_arg(&args, "relayUrl")) {
                Ok(pairing) => {
                    a.reset();
                    let _ = a.relay();
                    ToolReply::text(connect_text(&pairing))
                }
                Err(e) => ToolReply::error(format!("GrantTap pairing could not be created: {e}")),
            },
        )
        .tool(
            "notify",
            "Push a short status/message to the user's phone. Fire-and-forget — use it to keep them informed without blocking.",
            schema_message,
            move |_ctx, args| {
                let Some(message) = str_arg(&args, "message") else {
                    return ToolReply::error("message is required");
                };
                match b.relay() {
                    Ok(client) => {
                        let payload = json!({
                            "type": "agent.event",
                            "text": message,
                            "kind": "status",
                            "createdAt": now_ms(),
                        });
                        match client.send(&payload, "phone", Some(15 * 60_000), true, None) {
                            Ok(()) => ToolReply::text("sent to phone"),
                            Err(e) => ToolReply::error(e),
                        }
                    }
                    Err(_) => ToolReply::text(NOT_PAIRED),
                }
            },
        )
        .tool(
            "ask_yes_no",
            "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no'.",
            schema_question.clone(),
            move |_ctx, args| {
                let Some(question) = str_arg(&args, "question") else {
                    return ToolReply::error("question is required");
                };
                let Ok(client) = c.relay() else {
                    return ToolReply::text(NOT_PAIRED);
                };
                let request_id = random_id(6).unwrap_or_else(|_| "ask".into());
                let shellish = question.trim().to_ascii_lowercase().starts_with("allow")
                    || question.to_ascii_lowercase().contains("cursor shell");
                let payload = json!({
                    "type": "approval.request",
                    "requestId": request_id,
                    "agent": if shellish { "cursor" } else { "granttap" },
                    "kind": "permission",
                    "tool": if shellish { "Shell" } else { "ask_yes_no" },
                    "title": question,
                    "risk": if shellish { "medium" } else { "low" },
                    "createdAt": now_ms(),
                });
                if let Err(e) = client.send(
                    &payload,
                    "phone",
                    Some(ask_timeout().as_millis() as u64),
                    true,
                    Some(&request_id),
                ) {
                    return ToolReply::error(e);
                }
                let rid = request_id.clone();
                let answer = client.wait_for(ask_timeout(), move |p| {
                    let obj = match p.as_object() {
                        Some(o) => o,
                        None => return false,
                    };
                    let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if ty == "approval.decision"
                        && obj.get("requestId").and_then(|v| v.as_str()) == Some(rid.as_str())
                    {
                        let decided_by = obj.get("decidedBy").and_then(|v| v.as_str()).unwrap_or("");
                        let note = obj.get("note").and_then(|v| v.as_str()).unwrap_or("");
                        if decided_by == "system" && note.contains("dismissed") {
                            return false;
                        }
                        return true;
                    }
                    if ty == "user.message"
                        && obj.get("requestId").and_then(|v| v.as_str()) == Some(rid.as_str())
                    {
                        return parse_yes_no(obj.get("text").and_then(|v| v.as_str()).unwrap_or(""))
                            .is_some();
                    }
                    false
                });
                let text = match answer {
                    Some(v) => {
                        let obj = v.as_object();
                        if let Some(obj) = obj {
                            if obj.get("type").and_then(|x| x.as_str()) == Some("approval.decision")
                            {
                                if obj.get("decision").and_then(|x| x.as_str()) == Some("allow") {
                                    "yes"
                                } else {
                                    "no"
                                }
                            } else {
                                parse_yes_no(obj.get("text").and_then(|x| x.as_str()).unwrap_or(""))
                                    .unwrap_or("no-answer (timeout)")
                            }
                        } else {
                            "no-answer (timeout)"
                        }
                    }
                    None => "no-answer (timeout)",
                };
                ToolReply::text(text)
            },
        )
        .tool(
            "ask",
            "Ask the user an open question on their phone/watch and wait for their spoken or typed reply. Returns their answer text.",
            schema_question,
            move |_ctx, args| {
                let Some(question) = str_arg(&args, "question") else {
                    return ToolReply::error("question is required");
                };
                let Ok(client) = d.relay() else {
                    return ToolReply::text(NOT_PAIRED);
                };
                let request_id = random_id(6).unwrap_or_else(|_| "ask".into());
                let payload = json!({
                    "type": "agent.event",
                    "text": question,
                    "requestId": request_id,
                    "kind": "question",
                    "createdAt": now_ms(),
                });
                if let Err(e) =
                    client.send(&payload, "phone", Some(ask_timeout().as_millis() as u64), true, None)
                {
                    return ToolReply::error(e);
                }
                let rid = request_id.clone();
                let reply = client.wait_for(ask_timeout(), move |p| {
                    p.as_object()
                        .map(|o| {
                            o.get("type").and_then(|v| v.as_str()) == Some("user.message")
                                && o.get("requestId").and_then(|v| v.as_str()) == Some(rid.as_str())
                        })
                        .unwrap_or(false)
                });
                match reply {
                    Some(v) => ToolReply::text(
                        v.as_object()
                            .and_then(|o| o.get("text"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("no-answer (timeout)"),
                    ),
                    None => ToolReply::text("no-answer (timeout)"),
                }
            },
        )
        .tool(
            "setup",
            "Register GrantTap approval hooks and terminal-free background task sync on this machine.",
            schema_empty.clone(),
            |_ctx, _args| ToolReply::text(run_setup()),
        )
        .tool(
            "status",
            "Diagnose GrantTap on this machine: pairing file, LaunchAgent, monitor.log, sessions.status.",
            schema_empty,
            |_ctx, _args| ToolReply::text(render_status()),
        )
        .serve(RuntimeConfig {
            // ask / ask_yes_no may wait up to GRANTTAP_ASK_TIMEOUT_MS (default 180s).
            handler_deadline: None,
            ..RuntimeConfig::default()
        })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.as_object()
        .and_then(|o| o.get(key))
        .and_then(|v| v.as_str())
}

fn parse_yes_no(text: &str) -> Option<&'static str> {
    let t = text.trim().to_ascii_lowercase();
    if t.starts_with('y')
        || t.starts_with("да")
        || t.starts_with("ok")
        || t.starts_with("allow")
        || t.starts_with("approve")
        || t.starts_with("lgtm")
    {
        return Some("yes");
    }
    if t.starts_with('n')
        || t.starts_with("нет")
        || t.starts_with("deny")
        || t.starts_with("reject")
        || t.starts_with("cancel")
    {
        return Some("no");
    }
    None
}
