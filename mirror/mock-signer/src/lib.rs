//! Public disposable local sandbox fixture only. Never deploy on a live network.
use k256::ecdsa::SigningKey;

use near_sdk::{
    env, near, require,
    serde_json::{json, Value},
};
#[near(contract_state)]
#[derive(Default)]
pub struct MockSigner {}
#[near]
impl MockSigner {
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(
            request["path"] == "truenav-mirror-v1" && request["domain_id"] == 0,
            "wrong domain or path"
        );
        require!(env::attached_deposit().as_yoctonear() == 1, "wrong deposit");
        let h = request["payload_v2"]["Ecdsa"]
            .as_str()
            .expect("hash required");
        require!(
            h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit()),
            "invalid hash"
        );
        let hash: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("hex"))
            .collect();
        // A public fixture phrase, not a credential. Matches mirror/vectors.mjs.
        let seed = env::sha256(b"TrueNav public disposable mirror signing fixture v1");
        let key = SigningKey::from_slice(&seed).expect("public fixture scalar");
        let (signature, recovery) = key
            .sign_prehash_recoverable(&hash)
            .expect("sign fixture hash");
        let bytes = signature.to_bytes();
        let hex = |b: &[u8]| b.iter().map(|b| format!("{b:02x}")).collect::<String>();
        json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("{:02x}{}",2+recovery.to_byte(),hex(&bytes[..32]))},
            "s":{"scalar":hex(&bytes[32..])},"recovery_id":recovery.to_byte()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env, NearToken};
    #[test]
    fn matches_the_public_viem_fixture() {
        let mut builder = VMContextBuilder::new();
        builder.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(builder.build());
        let vectors: Value =
            near_sdk::serde_json::from_str(include_str!("../../fixtures/vectors.json")).unwrap();
        let response = MockSigner::default().sign(json!({"path":"truenav-mirror-v1","domain_id":0,"payload_v2":{"Ecdsa":vectors[0]["hash"]}}));
        assert_eq!(response, vectors[0]["response"]);
    }
}
