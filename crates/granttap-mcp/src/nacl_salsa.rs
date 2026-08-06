//! XSalsa20 / HSalsa20 for NaCl `crypto_box` / `crypto_secretbox` wire compat.

const SIGMA: [u32; 4] = [
    u32::from_le_bytes(*b"expa"),
    u32::from_le_bytes(*b"nd 3"),
    u32::from_le_bytes(*b"2-by"),
    u32::from_le_bytes(*b"te k"),
];

#[inline]
fn rotl(x: u32, n: u32) -> u32 {
    x.rotate_left(n)
}

fn quarter_idx(x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    x[b] ^= rotl(x[a].wrapping_add(x[d]), 7);
    x[c] ^= rotl(x[b].wrapping_add(x[a]), 9);
    x[d] ^= rotl(x[c].wrapping_add(x[b]), 13);
    x[a] ^= rotl(x[d].wrapping_add(x[c]), 18);
}

fn salsa20_core(input: &[u32; 16]) -> [u32; 16] {
    let mut x = *input;
    for _ in 0..10 {
        quarter_idx(&mut x, 0, 4, 8, 12);
        quarter_idx(&mut x, 5, 9, 13, 1);
        quarter_idx(&mut x, 10, 14, 2, 6);
        quarter_idx(&mut x, 15, 3, 7, 11);
        quarter_idx(&mut x, 0, 1, 2, 3);
        quarter_idx(&mut x, 5, 6, 7, 4);
        quarter_idx(&mut x, 10, 11, 8, 9);
        quarter_idx(&mut x, 15, 12, 13, 14);
    }
    for i in 0..16 {
        x[i] = x[i].wrapping_add(input[i]);
    }
    x
}

fn load_key(key: &[u8; 32]) -> [u32; 8] {
    let mut out = [0_u32; 8];
    for (i, slot) in out.iter_mut().enumerate() {
        let start = i * 4;
        *slot = u32::from_le_bytes(key[start..start + 4].try_into().unwrap());
    }
    out
}

/// HSalsa20(key, nonce16) → 32-byte subkey (NaCl before_nm).
#[must_use]
pub fn hsalsa20(key: &[u8; 32], nonce: &[u8; 16]) -> [u8; 32] {
    let k = load_key(key);
    let mut input = [0_u32; 16];
    input[0] = SIGMA[0];
    input[1] = k[0];
    input[2] = k[1];
    input[3] = k[2];
    input[4] = k[3];
    input[5] = SIGMA[1];
    input[6] = u32::from_le_bytes(nonce[0..4].try_into().unwrap());
    input[7] = u32::from_le_bytes(nonce[4..8].try_into().unwrap());
    input[8] = u32::from_le_bytes(nonce[8..12].try_into().unwrap());
    input[9] = u32::from_le_bytes(nonce[12..16].try_into().unwrap());
    input[10] = SIGMA[2];
    input[11] = k[4];
    input[12] = k[5];
    input[13] = k[6];
    input[14] = k[7];
    input[15] = SIGMA[3];

    let x = salsa20_core(&input);
    let words = [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]];
    let mut out = [0_u8; 32];
    for (i, w) in words.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

fn salsa20_block(key: &[u8; 32], nonce: &[u8; 8], counter: u64) -> [u8; 64] {
    let k = load_key(key);
    let mut input = [0_u32; 16];
    input[0] = SIGMA[0];
    input[1] = k[0];
    input[2] = k[1];
    input[3] = k[2];
    input[4] = k[3];
    input[5] = SIGMA[1];
    input[6] = u32::from_le_bytes(nonce[0..4].try_into().unwrap());
    input[7] = u32::from_le_bytes(nonce[4..8].try_into().unwrap());
    input[8] = counter as u32;
    input[9] = (counter >> 32) as u32;
    input[10] = SIGMA[2];
    input[11] = k[4];
    input[12] = k[5];
    input[13] = k[6];
    input[14] = k[7];
    input[15] = SIGMA[3];
    let x = salsa20_core(&input);
    let mut out = [0_u8; 64];
    for (i, w) in x.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

/// XSalsa20 keystream XOR (NaCl secretbox stream).
pub fn xsalsa20_xor(key: &[u8; 32], nonce24: &[u8; 24], message: &[u8]) -> Vec<u8> {
    let mut n16 = [0_u8; 16];
    n16.copy_from_slice(&nonce24[..16]);
    let subkey = hsalsa20(key, &n16);
    let mut n8 = [0_u8; 8];
    n8.copy_from_slice(&nonce24[16..24]);

    let mut out = vec![0_u8; message.len()];
    let mut offset = 0_usize;
    let mut counter = 0_u64;
    while offset < message.len() {
        let block = salsa20_block(&subkey, &n8, counter);
        let take = (message.len() - offset).min(64);
        for i in 0..take {
            out[offset + i] = message[offset + i] ^ block[i];
        }
        offset += take;
        counter = counter.wrapping_add(1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsalsa20_zero_vector_shape() {
        let key = [0_u8; 32];
        let nonce = [0_u8; 16];
        let out = hsalsa20(&key, &nonce);
        assert_ne!(out, [0_u8; 32]);
    }
}
