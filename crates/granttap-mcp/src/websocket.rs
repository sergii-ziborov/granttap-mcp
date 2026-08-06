//! Minimal RFC6455 client over a byte stream (Tokio-free).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub trait ByteStream: Read + Write + Send {}
impl<T: Read + Write + Send> ByteStream for T {}

pub struct WebSocket {
    stream: Box<dyn ByteStream>,
    read_buf: Vec<u8>,
}

impl WebSocket {
    pub fn connect_ws(url: &str, timeout: Duration) -> io::Result<Self> {
        let (host, port, path) = parse_ws_url(url, false)?;
        let addr = format!("{host}:{port}");
        let mut stream = TcpStream::connect(addr)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        handshake(&mut stream, &host, port, &path, false)?;
        Ok(Self {
            stream: Box::new(stream),
            read_buf: Vec::new(),
        })
    }

    #[cfg(target_os = "macos")]
    pub fn connect_wss(url: &str, timeout: Duration) -> io::Result<Self> {
        let (host, port, path) = parse_ws_url(url, true)?;
        let tcp = TcpStream::connect(format!("{host}:{port}"))?;
        tcp.set_read_timeout(Some(timeout))?;
        tcp.set_write_timeout(Some(timeout))?;
        let mut tls = crate::tls_macos::TlsStream::connect(tcp, &host)?;
        handshake(&mut tls, &host, port, &path, true)?;
        Ok(Self {
            stream: Box::new(tls),
            read_buf: Vec::new(),
        })
    }

    pub fn send_text(&mut self, text: &str) -> io::Result<()> {
        write_frame(&mut self.stream, 0x1, text.as_bytes())
    }

    pub fn read_text(&mut self, timeout: Duration) -> io::Result<Option<String>> {
        let _ = timeout;
        match read_frame(&mut self.stream, &mut self.read_buf)? {
            Frame::Text(s) => Ok(Some(s)),
            Frame::Ping(payload) => {
                write_frame(&mut self.stream, 0xA, &payload)?;
                Ok(None)
            }
            Frame::Close => Ok(None),
            Frame::Binary(_) | Frame::Pong => Ok(None),
        }
    }

    pub fn close(&mut self) {
        let _ = write_frame(&mut self.stream, 0x8, &[]);
    }
}

enum Frame {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong,
    Close,
}

fn parse_ws_url(url: &str, want_tls: bool) -> io::Result<(String, u16, String)> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad url"))?;
    if want_tls && scheme != "wss" {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "expected wss"));
    }
    if !want_tls && scheme != "ws" {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "expected ws"));
    }
    let (hostport, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{p}")),
        None => (rest.to_string(), "/".into()),
    };
    let (host, port) = if let Some((h, p)) = hostport.rsplit_once(':') {
        (
            h.trim_start_matches('[').trim_end_matches(']').to_string(),
            p.parse()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad port"))?,
        )
    } else {
        (
            hostport.trim_start_matches('[').trim_end_matches(']').to_string(),
            if want_tls { 443 } else { 80 },
        )
    };
    Ok((host, port, path))
}

fn handshake<S: Write + Read>(
    stream: &mut S,
    host: &str,
    port: u16,
    path: &str,
    tls: bool,
) -> io::Result<()> {
    let key = {
        let mut rnd = [0_u8; 16];
        blindplane_crypto::rand::fill(&mut rnd)
            .map_err(|e| io::Error::other(e.to_string()))?;
        crate::crypto::b64(&rnd)
    };
    let host_header = if (tls && port == 443) || (!tls && port == 80) {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    let mut buf = vec![0_u8; 4096];
    let mut got = Vec::new();
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "websocket handshake eof",
            ));
        }
        got.extend_from_slice(&buf[..n]);
        if got.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if got.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "handshake too large",
            ));
        }
    }
    let text = String::from_utf8_lossy(&got);
    if !text.contains("101") {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("websocket upgrade failed: {}", text.lines().next().unwrap_or("")),
        ));
    }
    Ok(())
}

fn write_frame<W: Write>(w: &mut W, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = Vec::with_capacity(14);
    header.push(0x80 | opcode);
    let mut mask = [0_u8; 4];
    blindplane_crypto::rand::fill(&mut mask).map_err(|e| io::Error::other(e.to_string()))?;
    let len = payload.len();
    if len < 126 {
        header.push(0x80 | (len as u8));
    } else if len <= u16::MAX as usize {
        header.push(0x80 | 126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(0x80 | 127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    header.extend_from_slice(&mask);
    let mut masked = payload.to_vec();
    for (i, b) in masked.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
    w.write_all(&header)?;
    w.write_all(&masked)?;
    w.flush()
}

fn read_frame<R: Read>(r: &mut R, carry: &mut Vec<u8>) -> io::Result<Frame> {
    let _ = carry;
    let mut hdr = [0_u8; 2];
    r.read_exact(&mut hdr)?;
    let opcode = hdr[0] & 0x0f;
    let masked = hdr[1] & 0x80 != 0;
    let mut len = (hdr[1] & 0x7f) as u64;
    if len == 126 {
        let mut ext = [0_u8; 2];
        r.read_exact(&mut ext)?;
        len = u64::from(u16::from_be_bytes(ext));
    } else if len == 127 {
        let mut ext = [0_u8; 8];
        r.read_exact(&mut ext)?;
        len = u64::from_be_bytes(ext);
    }
    let mut mask = [0_u8; 4];
    if masked {
        r.read_exact(&mut mask)?;
    }
    let mut payload = vec![0_u8; len as usize];
    if len > 0 {
        r.read_exact(&mut payload)?;
    }
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    match opcode {
        0x1 => Ok(Frame::Text(
            String::from_utf8(payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
        )),
        0x2 => Ok(Frame::Binary(payload)),
        0x8 => Ok(Frame::Close),
        0x9 => Ok(Frame::Ping(payload)),
        0xA => Ok(Frame::Pong),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported websocket opcode",
        )),
    }
}
