//! Keccak-256 (the Ethereum function, not NIST SHA3-256). Used only to hash a pledge ticket this module composed.

const RC: [u64; 24] = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
];

const ROT: [u32; 24] = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PIL: [usize; 24] = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

fn keccak_f(st: &mut [u64; 25]) {
    for round in 0..24 {
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
        }
        for x in 0..5 {
            let d = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
            for y in 0..5 {
                st[x + 5 * y] ^= d;
            }
        }
        let mut last = st[1];
        for i in 0..24 {
            let next = st[PIL[i]];
            st[PIL[i]] = last.rotate_left(ROT[i]);
            last = next;
        }
        for y in 0..5 {
            let row = [st[5 * y], st[1 + 5 * y], st[2 + 5 * y], st[3 + 5 * y], st[4 + 5 * y]];
            for x in 0..5 {
                st[x + 5 * y] = row[x] ^ ((!row[(x + 1) % 5]) & row[(x + 2) % 5]);
            }
        }
        st[0] ^= RC[round];
    }
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut st = [0u64; 25];
    let rate = 136usize;
    let mut offset = 0usize;
    while offset + rate <= data.len() {
        for i in 0..(rate / 8) {
            let mut lane = [0u8; 8];
            lane.copy_from_slice(&data[offset + i * 8..offset + i * 8 + 8]);
            st[i] ^= u64::from_le_bytes(lane);
        }
        keccak_f(&mut st);
        offset += rate;
    }
    let mut block = [0u8; 136];
    let rest = &data[offset..];
    block[..rest.len()].copy_from_slice(rest);
    block[rest.len()] = 0x01;
    block[rate - 1] |= 0x80;
    for i in 0..(rate / 8) {
        let mut lane = [0u8; 8];
        lane.copy_from_slice(&block[i * 8..i * 8 + 8]);
        st[i] ^= u64::from_le_bytes(lane);
    }
    keccak_f(&mut st);
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&st[0].to_le_bytes());
    out[8..16].copy_from_slice(&st[1].to_le_bytes());
    out[16..24].copy_from_slice(&st[2].to_le_bytes());
    out[24..32].copy_from_slice(&st[3].to_le_bytes());
    out
}
