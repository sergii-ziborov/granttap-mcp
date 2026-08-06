//! tweetnacl-compatible sealing for GrantTap envelopes.
//!
//! Phone + Node MCP use `nacl.box` / `nacl.secretbox`. We reproduce that wire
//! format with Blindplane X25519 + Poly1305 and local XSalsa20.

use crate::nacl_salsa::{hsalsa20, xsalsa20_xor};
use blindplane_crypto::montgomery::{self, StaticSecret};
use blindplane_crypto::poly1305::Poly1305;
use blindplane_crypto::rand;

const ZERO_NONCE: [u8; 16] = [0_u8; 16];

#[derive(Clone, Debug)]
pub struct KeyPair {
    pub public_key: String,
    pub secret_key: String,
}

pub fn generate_key_pair() -> Result<KeyPair, String> {
    let sk = StaticSecret::generate().map_err(|e| e.to_string())?;
    Ok(KeyPair {
        public_key: b64(&sk.public_key()),
        secret_key: b64(&sk.to_bytes()),
    })
}

pub fn random_id(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0_u8; bytes];
    rand::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(hex(&buf))
}

pub fn generate_transfer_key() -> Result<String, String> {
    let mut key = [0_u8; 32];
    rand::fill(&mut key).map_err(|e| e.to_string())?;
    Ok(b64url(&key))
}

pub fn seal(
    payload: &blazingly_json::Value,
    their_public_key: &str,
    my_secret_key: &str,
) -> Result<(String, String), String> {
    let msg = blazingly_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut nonce = [0_u8; 24];
    rand::fill(&mut nonce).map_err(|e| e.to_string())?;
    let box_bytes = crypto_box(
        &msg,
        &nonce,
        &key32(their_public_key)?,
        &key32(my_secret_key)?,
    )?;
    Ok((b64(&nonce), b64(&box_bytes)))
}

pub fn open(
    nonce_b64: &str,
    box_b64: &str,
    their_public_key: &str,
    my_secret_key: &str,
) -> Option<blazingly_json::Value> {
    let nonce = decode_b64(nonce_b64).ok()?;
    let boxed = decode_b64(box_b64).ok()?;
    let nonce_arr: [u8; 24] = nonce.as_slice().try_into().ok()?;
    let opened = crypto_box_open(
        &boxed,
        &nonce_arr,
        &key32(their_public_key).ok()?,
        &key32(my_secret_key).ok()?,
    )?;
    blazingly_json::from_slice(&opened).ok()
}

pub fn seal_with_transfer_key(
    payload: &blazingly_json::Value,
    key: &str,
) -> Result<(String, String), String> {
    let key_bytes = transfer_key_bytes(key)?;
    let msg = blazingly_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut nonce = [0_u8; 24];
    rand::fill(&mut nonce).map_err(|e| e.to_string())?;
    let boxed = secretbox(&msg, &nonce, &key_bytes);
    Ok((b64(&nonce), b64(&boxed)))
}

fn transfer_key_bytes(key: &str) -> Result<[u8; 32], String> {
    let decoded = ub64url(key)?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| "invalid 256-bit transfer key".into())
}

fn crypto_box(
    message: &[u8],
    nonce: &[u8; 24],
    their_pk: &[u8; 32],
    my_sk: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let shared = montgomery::x25519(my_sk, their_pk);
    if shared.iter().all(|&b| b == 0) {
        return Err("degenerate x25519 shared secret".into());
    }
    let k = hsalsa20(&shared, &ZERO_NONCE);
    Ok(secretbox(message, nonce, &k))
}

fn crypto_box_open(
    boxed: &[u8],
    nonce: &[u8; 24],
    their_pk: &[u8; 32],
    my_sk: &[u8; 32],
) -> Option<Vec<u8>> {
    let shared = montgomery::x25519(my_sk, their_pk);
    if shared.iter().all(|&b| b == 0) {
        return None;
    }
    let k = hsalsa20(&shared, &ZERO_NONCE);
    secretbox_open(boxed, nonce, &k)
}

/// NaCl crypto_secretbox wire form: tag(16) || ciphertext (tweetnacl.js `box`).
fn secretbox(message: &[u8], nonce: &[u8; 24], key: &[u8; 32]) -> Vec<u8> {
    let mut m = vec![0_u8; 32 + message.len()];
    m[32..].copy_from_slice(message);
    let mut c = xsalsa20_xor(key, nonce, &m);
    let mut poly_key = [0_u8; 32];
    poly_key.copy_from_slice(&c[..32]);
    let mut poly = Poly1305::new(&poly_key);
    poly.update(&c[32..]);
    let tag = poly.finalize();
    c[16..32].copy_from_slice(&tag);
    for b in &mut c[..16] {
        *b = 0;
    }
    // JS/tweetnacl returns c.subarray(16) → tag || ciphertext
    c[16..].to_vec()
}

fn secretbox_open(boxed: &[u8], nonce: &[u8; 24], key: &[u8; 32]) -> Option<Vec<u8>> {
    if boxed.len() < 16 {
        return None;
    }
    let mut c = vec![0_u8; 16 + boxed.len()];
    c[16..].copy_from_slice(boxed);
    // First 32 keystream bytes are the Poly1305 one-time key.
    let zeros = [0_u8; 32];
    let stream0 = xsalsa20_xor(key, nonce, &zeros);
    let mut poly_key = [0_u8; 32];
    poly_key.copy_from_slice(&stream0);
    let mut poly = Poly1305::new(&poly_key);
    poly.update(&c[32..]);
    if !poly.verify(&c[16..32]).is_set() {
        return None;
    }
    let plain = xsalsa20_xor(key, nonce, &c);
    Some(plain[32..].to_vec())
}

pub fn b64(bytes: &[u8]) -> String {
    base64_encode(bytes, false)
}

pub fn b64url(bytes: &[u8]) -> String {
    base64_encode(bytes, true)
}

fn key32(s: &str) -> Result<[u8; 32], String> {
    let v = decode_b64(s)?;
    v.as_slice()
        .try_into()
        .map_err(|_| "expected 32-byte key".into())
}

fn ub64url(s: &str) -> Result<Vec<u8>, String> {
    base64_decode(s, true)
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    base64_decode(s, false)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

fn base64_encode(bytes: &[u8], url: bool) -> String {
    const STD: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const URL: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let table = if url { URL } else { STD };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(table[((n >> 18) & 63) as usize] as char);
        out.push(table[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(table[((n >> 6) & 63) as usize] as char);
        } else if !url {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(table[(n & 63) as usize] as char);
        } else if !url {
            out.push('=');
        }
    }
    out
}

fn base64_decode(input: &str, url: bool) -> Result<Vec<u8>, String> {
    let mut s = input.trim().as_bytes().to_vec();
    if url {
        for b in &mut s {
            if *b == b'-' {
                *b = b'+';
            }
            if *b == b'_' {
                *b = b'/';
            }
        }
        while s.len() % 4 != 0 {
            s.push(b'=');
        }
    }
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' | b'-' => Ok(62),
            b'/' | b'_' => Ok(63),
            _ => Err("invalid base64".into()),
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= s.len() {
        let a = s[i];
        let b = s[i + 1];
        let c = s[i + 2];
        let d = s[i + 3];
        i += 4;
        if a == b'=' {
            break;
        }
        let n = (u32::from(val(a)?) << 18)
            | (u32::from(val(b)?) << 12)
            | (u32::from(if c == b'=' { 0 } else { val(c)? }) << 6)
            | u32::from(if d == b'=' { 0 } else { val(d)? });
        out.push((n >> 16) as u8);
        if c != b'=' {
            out.push((n >> 8) as u8);
        }
        if d != b'=' {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blazingly_json::json;

    #[test]
    fn box_roundtrip() {
        let a = generate_key_pair().unwrap();
        let b = generate_key_pair().unwrap();
        let payload = json!({"type": "hello", "ok": true});
        let (nonce, boxed) = seal(&payload, &b.public_key, &a.secret_key).unwrap();
        let opened = open(&nonce, &boxed, &a.public_key, &b.secret_key).unwrap();
        assert_eq!(opened, payload);
    }
}
