//! Constrained Base Sepolia transactions. No fields are added to Receipts or its collection prefixes.
use crate::*;

pub const CHAIN_ID: u64 = 84532;
pub const PATH: &str = "truenav-mirror-v1";
pub const GAS_LIMIT: u64 = 150_000;
pub const MAX_FEE: u64 = 100_000_000_000;
const STATE_KEY: &[u8] = b"mirror:v1:state";
const MAX_ATTEMPTS: usize = 16;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MirrorConfig {
    pub chain_id: u64,
    pub mirror_address: String,
    pub fee_cap: u64,
    /// Uncompressed derived key without the 04 prefix, from the signer's derived_public_key view.
    pub public_key: String,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MirrorState {
    pub config: MirrorConfig,
    pub next_nonce: u64,
    pub pending: Option<u64>,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MirrorAttempt {
    pub fee: u64,
    pub unsigned_payload: Vec<u8>,
    pub signed_tx: Option<String>,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MirrorRequest {
    pub nonce: u64,
    pub seq: u64,
    pub token_id: String,
    pub to: String,
    pub data: Vec<u8>,
    pub attempts: Vec<MirrorAttempt>,
    pub signing: bool,
    pub confirmed_tx: Option<String>,
}
fn key(nonce: u64) -> Vec<u8> {
    [b"mirror:v1:request:".as_slice(), &nonce.to_le_bytes()].concat()
}
fn read<T: BorshDeserialize>(key: &[u8]) -> T {
    borsh::from_slice(&env::storage_read(key).expect("mirror not configured or request missing"))
        .expect("invalid mirror state")
}
fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(key, &borsh::to_vec(value).expect("mirror serialization"));
}
pub fn unhex(s: &str, len: usize) -> Option<Vec<u8>> {
    if s.len() != len * 2
        || !s
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    (0..len)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}
fn number(n: u64) -> Vec<u8> {
    let b = n.to_be_bytes();
    b.iter().skip_while(|b| **b == 0).copied().collect()
}
fn length(n: usize, short: u8, long: u8) -> Vec<u8> {
    if n < 56 {
        vec![short + n as u8]
    } else {
        let b = number(n as u64);
        [vec![long + b.len() as u8], b].concat()
    }
}
fn rlp(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 128 {
        return b.to_vec();
    }
    [length(b.len(), 128, 183), b.to_vec()].concat()
}
fn list(fields: &[Vec<u8>]) -> Vec<u8> {
    let body = fields.concat();
    [length(body.len(), 192, 247), body].concat()
}
/// Fixed chain, recipient, zero value, fixed gas limit and empty access list. Fee changes cannot change calldata.
pub fn transaction(
    nonce: u64,
    fee: u64,
    to: &[u8],
    data: &[u8],
    signature: Option<(u8, &[u8], &[u8])>,
) -> Vec<u8> {
    let mut fields = vec![
        rlp(&number(CHAIN_ID)),
        rlp(&number(nonce)),
        rlp(&number(fee)),
        rlp(&number(fee)),
        rlp(&number(GAS_LIMIT)),
        rlp(to),
        rlp(&[]),
        rlp(data),
        list(&[]),
    ];
    if let Some((v, r, s)) = signature {
        fields.extend([
            rlp(&number(v as u64)),
            rlp(r
                .iter()
                .skip_while(|b| **b == 0)
                .copied()
                .collect::<Vec<_>>()
                .as_slice()),
            rlp(s
                .iter()
                .skip_while(|b| **b == 0)
                .copied()
                .collect::<Vec<_>>()
                .as_slice()),
        ]);
    }
    [vec![2], list(&fields)].concat()
}
fn word(n: u64) -> Vec<u8> {
    [vec![0; 24], n.to_be_bytes().to_vec()].concat()
}
pub fn as_of_ms(s: &str) -> Option<u64> {
    if !validate::is_utc_ts(s) {
        return None;
    }
    let num = |a, b| s.get(a..b)?.parse::<u64>().ok();
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if year < 1970 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > months[(month - 1) as usize] {
        return None;
    }
    let days: u64 = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..(month - 1) as usize].iter().sum::<u64>()
        + day
        - 1;
    Some(
        ((days * 24 + hour) * 3600 + minute * 60 + second) * 1000
            + if s.len() == 24 { num(20, 23)? } else { 0 },
    )
}
pub fn calldata(r: &StoredReceipt) -> Vec<u8> {
    let selector = env::keccak256(b"update(bytes32,uint256,bytes32,uint8,uint8,bytes32,uint64)");
    let band = match r.band.as_str() {
        "red" => 0,
        "yellow" => 1,
        "green" => 2,
        _ => env::panic_str("bad stored band"),
    };
    [
        selector[..4].to_vec(),
        env::sha256(r.token_id.as_bytes()),
        word(r.seq),
        unhex(&r.receipt_sha256, 32).expect("bad stored receipt hash"),
        word(r.score),
        word(band),
        env::sha256(r.method.as_bytes()),
        word(as_of_ms(&r.as_of).expect("bad stored timestamp")),
    ]
    .concat()
}

#[near]
impl Receipts {
    #[payable]
    pub fn set_mirror_config(&mut self, config: MirrorConfig) {
        self.only_admin();
        require!(!self.paused, "paused");
        require!(config.chain_id == CHAIN_ID, "Base Sepolia only");
        require!(
            config.fee_cap > 0 && config.fee_cap <= MAX_FEE,
            "bad fee cap"
        );
        let address = unhex(&config.mirror_address, 20).expect("bad mirror address");
        require!(address.iter().any(|b| *b != 0), "zero mirror address");
        unhex(&config.public_key, 64).expect("bad derived public key");
        let old = env::storage_read(STATE_KEY)
            .map(|raw| borsh::from_slice::<MirrorState>(&raw).expect("invalid mirror state"));
        require!(
            old.as_ref().is_none_or(|s| s.pending.is_none()),
            "mirror pending"
        );
        write(
            STATE_KEY,
            &MirrorState {
                config,
                next_nonce: old.map_or(0, |s| s.next_nonce),
                pending: None,
            },
        );
    }
    pub fn get_mirror_config(&self) -> Option<MirrorState> {
        env::storage_read(STATE_KEY)
            .map(|raw| borsh::from_slice(&raw).expect("invalid mirror state"))
    }
    pub fn get_mirror_request(&self, nonce: u64) -> Option<MirrorRequest> {
        env::storage_read(&key(nonce))
            .map(|raw| borsh::from_slice(&raw).expect("invalid mirror state"))
    }
    #[payable]
    pub fn request_mirror(&mut self, token_id: String, seq: u64, fee: u64) -> Promise {
        self.only_admin();
        require!(!self.paused, "paused");
        let mut state: MirrorState = read(STATE_KEY);
        require!(state.pending.is_none(), "earlier nonce unconfirmed");
        require!(fee > 0 && fee <= state.config.fee_cap, "fee above cap");
        require!(state.next_nonce < u64::MAX, "nonce exhausted");
        let receipt = self
            .get_receipt(token_id.clone(), seq)
            .expect("stored receipt required");
        let nonce = state.next_nonce;
        let request = MirrorRequest {
            nonce,
            seq,
            token_id,
            to: state.config.mirror_address.clone(),
            data: calldata(&receipt),
            attempts: vec![],
            signing: false,
            confirmed_tx: None,
        };
        state.pending = Some(nonce);
        write(STATE_KEY, &state);
        write(&key(nonce), &request);
        self.mirror_sign(nonce, fee)
    }
    #[payable]
    pub fn clear_mirror_signing(&mut self, nonce: u64) {
        self.only_admin();
        require!(!self.paused, "paused");
        let state: MirrorState = read(STATE_KEY);
        require!(state.pending == Some(nonce), "not pending nonce");
        let mut request: MirrorRequest = read(&key(nonce));
        require!(request.signing, "no signature pending");
        request.signing = false;
        write(&key(nonce), &request);
        emit("mirror_signing_cleared", json!({ "nonce": nonce }));
    }
    #[payable]
    pub fn resign_mirror(&mut self, nonce: u64, fee: u64) -> Promise {
        self.only_admin();
        require!(!self.paused, "paused");
        self.mirror_sign(nonce, fee)
    }
    fn mirror_sign(&mut self, nonce: u64, fee: u64) -> Promise {
        let state: MirrorState = read(STATE_KEY);
        require!(state.pending == Some(nonce), "not pending nonce");
        let mut request: MirrorRequest = read(&key(nonce));
        require!(!request.signing, "signature pending");
        require!(
            request.attempts.len() < MAX_ATTEMPTS,
            "attempt limit reached"
        );
        require!(fee > 0 && fee <= state.config.fee_cap, "fee above cap");
        require!(
            request.attempts.last().is_none_or(|a| fee > a.fee),
            "fee must increase"
        );
        let payload = transaction(
            nonce,
            fee,
            &unhex(&request.to, 20).expect("address"),
            &request.data,
            None,
        );
        let hash = env::keccak256(&payload);
        // The signer accepts only secp256k1 scalar hashes; a vanishingly rare out-of-range hash fails closed.
        require!(
            hash.as_slice() < ORDER.as_slice(),
            "hash outside signer scalar range"
        );
        let attempt = request.attempts.len();
        request.attempts.push(MirrorAttempt {
            fee,
            unsigned_payload: payload,
            signed_tx: None,
        });
        request.signing = true;
        write(&key(nonce), &request);
        Promise::new("v1.signer-prod.testnet".parse().expect("signer account"))
            .function_call(
                "sign",
                json!({"request":{"path":PATH,"domain_id":0,"payload_v2":{"Ecdsa":hex(&hash)}}})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(100),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_mirror_signed",
                    json!({"nonce":nonce,"attempt":attempt})
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(35),
                ),
            )
    }
    #[private]
    pub fn on_mirror_signed(&mut self, nonce: u64, attempt: u32) -> bool {
        let state: MirrorState = read(STATE_KEY);
        let mut request: MirrorRequest = read(&key(nonce));
        if state.pending != Some(nonce)
            || !request.signing
            || attempt as usize + 1 != request.attempts.len()
        {
            return false;
        }
        request.signing = false;
        let signed = env::promise_result_checked(0, 2048).ok().and_then(|raw| {
            let v: Value = serde_json::from_slice(&raw).ok()?;
            let point = unhex(v["big_r"]["affine_point"].as_str()?, 33)?;
            let mut s = unhex(v["s"]["scalar"].as_str()?, 32)?;
            let mut recovery = u8::try_from(v["recovery_id"].as_u64()?).ok()?;
            if !matches!(point[0], 2 | 3)
                || recovery > 1
                || s.iter().all(|b| *b == 0)
                || s.as_slice() >= ORDER.as_slice()
            {
                return None;
            }
            if s.as_slice() > HALF_ORDER.as_slice() {
                s = subtract(&ORDER, &s);
                recovery ^= 1;
            }
            let r = &point[1..];
            let a = &request.attempts[attempt as usize];
            let hash = env::keccak256(&a.unsigned_payload);
            let signature: [u8; 64] = [r, s.as_slice()].concat().try_into().ok()?;
            let recovered = env::ecrecover(hash.as_slice(), &signature, recovery, true)?;
            if recovered.as_slice() != unhex(&state.config.public_key, 64)?.as_slice() {
                return None;
            }
            Some(transaction(
                nonce,
                a.fee,
                &unhex(&request.to, 20)?,
                &request.data,
                Some((recovery, r, &s)),
            ))
        });
        if let Some(bytes) = signed {
            let raw = hex(&bytes);
            let tx_hash = hex(&env::keccak256(&bytes));
            request.attempts[attempt as usize].signed_tx = Some(raw.clone());
            write(&key(nonce), &request);
            emit(
                "mirror_signed",
                json!({"nonce":nonce,"seq":request.seq,"attempt":attempt,"signed_tx":raw,"tx_hash":tx_hash}),
            );
            true
        } else {
            write(&key(nonce), &request);
            emit(
                "mirror_sign_failed",
                json!({"nonce":nonce,"attempt":attempt}),
            );
            false
        }
    }
    /// Admin attests Base finalized success. All signed replacements remain eligible because any one can land.
    #[payable]
    pub fn confirm_mirror(&mut self, nonce: u64, tx_hash: String) {
        self.only_admin();
        require!(!self.paused, "paused");
        let mut state: MirrorState = read(STATE_KEY);
        require!(state.pending == Some(nonce), "not pending nonce");
        let mut request: MirrorRequest = read(&key(nonce));
        require!(!request.signing, "signature pending");
        unhex(&tx_hash, 32).expect("bad transaction hash");
        require!(request.attempts.iter().filter_map(|a| a.signed_tx.as_ref()).any(|s|
            unhex(s,s.len()/2).is_some_and(|b| hex(&env::keccak256(&b)) == tx_hash)), "unknown signed transaction");
        request.confirmed_tx = Some(tx_hash.clone());
        write(&key(nonce), &request);
        state.next_nonce = nonce.checked_add(1).expect("nonce exhausted");
        state.pending = None;
        write(STATE_KEY, &state);
        emit("mirror_confirmed", json!({"nonce":nonce,"tx_hash":tx_hash}));
    }
}
const ORDER: [u8; 32] = [
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 186, 174, 220,
    230, 175, 72, 160, 59, 191, 210, 94, 140, 208, 54, 65, 65,
];
const HALF_ORDER: [u8; 32] = [
    127, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 93, 87, 110,
    115, 87, 164, 80, 29, 223, 233, 47, 70, 104, 27, 32, 160,
];
fn subtract(a: &[u8; 32], b: &[u8]) -> Vec<u8> {
    let mut out = vec![0; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let n = a[i] as i16 - b[i] as i16 - borrow;
        out[i] = n as u8;
        borrow = i16::from(n < 0);
    }
    out
}
