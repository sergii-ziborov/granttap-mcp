//! E2EE relay client (WebSocket + NaCl box), shared by MCP tools.

use crate::config::PeerConfig;
use crate::crypto::{open, random_id, seal};
use crate::websocket::WebSocket;
use blazingly_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Listener = Box<dyn FnMut(&Value) -> bool + Send>;

#[derive(Clone)]
pub struct RelayClient {
    cfg: PeerConfig,
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    ws: Option<WebSocket>,
    listeners: Vec<Listener>,
}

impl RelayClient {
    pub fn new(cfg: PeerConfig) -> Self {
        Self {
            cfg,
            inner: Arc::new(Mutex::new(Inner {
                ws: None,
                listeners: Vec::new(),
            })),
        }
    }

    pub fn connect(&self, timeout: Duration) -> Result<(), String> {
        let mut url = self.cfg.relay_url.clone();
        let sep = if url.contains('?') { '&' } else { '?' };
        url = format!("{url}{sep}room={}", self.cfg.room);
        let ws = if url.starts_with("wss://") {
            #[cfg(target_os = "macos")]
            {
                WebSocket::connect_wss(&url, timeout).map_err(|e| e.to_string())?
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("wss:// requires macOS Secure Transport in this build".into());
            }
        } else {
            WebSocket::connect_ws(&url, timeout).map_err(|e| e.to_string())?
        };
        {
            let mut g = self.inner.lock().map_err(|e| e.to_string())?;
            g.ws = Some(ws);
        }
        let hello = json!({
            "type": "hello",
            "role": self.cfg.role,
            "deviceName": self.cfg.device_name,
            "createdAt": now_ms(),
        });
        let _ = self.send(&hello, "all", None, false, None);
        self.spawn_reader();
        Ok(())
    }

    fn spawn_reader(&self) {
        let inner = Arc::clone(&self.inner);
        let cfg = self.cfg.clone();
        thread::spawn(move || loop {
            let text = {
                let mut g = match inner.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                let Some(ws) = g.ws.as_mut() else {
                    break;
                };
                match ws.read_text(Duration::from_secs(60)) {
                    Ok(Some(t)) => t,
                    Ok(None) => continue,
                    Err(_) => break,
                }
            };
            if let Some(payload) = decode_envelope(&cfg, &text) {
                let mut g = match inner.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                for listener in &mut g.listeners {
                    let _ = listener(&payload);
                }
            }
        });
    }

    pub fn send(
        &self,
        payload: &Value,
        to: &str,
        ttl_ms: Option<u64>,
        wake: bool,
        delivery_id: Option<&str>,
    ) -> Result<(), String> {
        let (nonce, boxed) = seal(payload, &self.cfg.peer_public_key, &self.cfg.my_secret_key)?;
        let delivery = delivery_id
            .map(str::to_string)
            .unwrap_or_else(|| random_id(16).unwrap_or_else(|_| "0".into()));
        let mut env = json!({
            "v": 1,
            "room": self.cfg.room,
            "from": self.cfg.role,
            "to": to,
            "senderId": self.cfg.sender_id,
            "deliveryId": delivery,
            "nonce": nonce,
            "box": boxed,
        });
        if wake {
            if let Value::Object(map) = &mut env {
                map.insert("wake".into(), Value::Bool(true));
            }
        }
        if let Some(ttl) = ttl_ms {
            if let Value::Object(map) = &mut env {
                map.insert("expiresAt".into(), json!(now_ms() + ttl));
            }
        }
        let text = blazingly_json::to_string(&env).map_err(|e| e.to_string())?;
        let mut g = self.inner.lock().map_err(|e| e.to_string())?;
        let ws = g.ws.as_mut().ok_or("relay not connected")?;
        ws.send_text(&text).map_err(|e| e.to_string())
    }

    pub fn wait_for<F>(&self, timeout: Duration, mut pred: F) -> Option<Value>
    where
        F: FnMut(&Value) -> bool + Send + 'static,
    {
        let pair = Arc::new(Mutex::new(None::<Value>));
        let flag = Arc::clone(&pair);
        {
            let Ok(mut g) = self.inner.lock() else {
                return None;
            };
            g.listeners.push(Box::new(move |p| {
                if pred(p) {
                    if let Ok(mut slot) = flag.lock() {
                        *slot = Some(p.clone());
                    }
                    true
                } else {
                    false
                }
            }));
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(slot) = pair.lock() {
                if slot.is_some() {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        pair.lock().ok().and_then(|mut s| s.take())
    }

    pub fn close(&self) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(ws) = g.ws.as_mut() {
                ws.close();
            }
            g.ws = None;
            g.listeners.clear();
        }
    }
}

fn decode_envelope(cfg: &PeerConfig, raw: &str) -> Option<Value> {
    let env: Value = blazingly_json::from_str(raw).ok()?;
    let obj = env.as_object()?;
    let room = obj.get("room")?.as_str()?;
    if room != cfg.room {
        return None;
    }
    let from = obj.get("from")?.as_str()?;
    let other = if cfg.role == "machine" {
        "phone"
    } else {
        "machine"
    };
    if from != other {
        return None;
    }
    let nonce = obj.get("nonce")?.as_str()?;
    let boxed = obj.get("box")?.as_str()?;
    open(nonce, boxed, &cfg.peer_public_key, &cfg.my_secret_key)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
