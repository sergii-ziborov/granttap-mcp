//! Tiny HTTP/1.1 client for pairing mailbox PUT (Tokio-free).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub fn put_json(url: &str, body: &str, timeout: Duration) -> Result<u16, String> {
    let (tls, host, port, path) = parse_http_url(url)?;
    let addr = format!("{host}:{port}");
    let tcp = TcpStream::connect(&addr).map_err(|e| format!("connect {addr}: {e}"))?;
    tcp.set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;

    if tls {
        #[cfg(target_os = "macos")]
        {
            let mut stream =
                crate::tls_macos::TlsStream::connect(tcp, &host).map_err(|e| e.to_string())?;
            return exchange(&mut stream, &host, port, &path, body, true);
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err("https pairing currently requires macOS Secure Transport".into());
        }
    }
    let mut stream = tcp;
    exchange(&mut stream, &host, port, &path, body, false)
}

fn exchange<S: Read + Write>(
    stream: &mut S,
    host: &str,
    port: u16,
    path: &str,
    body: &str,
    tls: bool,
) -> Result<u16, String> {
    let host_header = if (tls && port == 443) || (!tls && port == 80) {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let req = format!(
        "PUT {path} HTTP/1.1\r\nHost: {host_header}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad http response: {}", text.chars().take(80).collect::<String>()))?;
    Ok(status)
}

fn parse_http_url(url: &str) -> Result<(bool, String, u16, String), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "bad url".to_string())?;
    let tls = match scheme {
        "https" => true,
        "http" => false,
        _ => return Err("url must be http(s)".into()),
    };
    let (hostport, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{p}")),
        None => (rest.to_string(), "/".into()),
    };
    let (host, port) = if let Some((h, p)) = hostport.rsplit_once(':') {
        (
            h.trim_start_matches('[').trim_end_matches(']').to_string(),
            p.parse().map_err(|_| "bad port".to_string())?,
        )
    } else {
        (
            hostport
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string(),
            if tls { 443 } else { 80 },
        )
    };
    Ok((tls, host, port, path))
}
