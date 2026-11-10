// Shared pledge signatures for contract unit tests.
// The servicer key and the ticket key are fixed throwaway secp256k1 keys. They hold no value.
// The ticket key is a LOCAL TEST KEY standing in for a TEE pledge key. It is not a TEE key and it is not attested hardware.
// Each test crate uses a different subset of these helpers.
#![allow(dead_code)]
use k256::ecdsa::SigningKey;
use truenav_registry::{eip191_digest, network_of, pledge_message};

pub const CONTRACT: &str = "registry.test.near";

/// Registered servicer pledge key used by unit tests. Not a NEAR account key.
pub fn servicer_key() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32].into()).unwrap()
}

/// LOCAL TEST KEY standing in for the TEE pledge ticket key. Not a TEE key.
pub fn ticket_test_key() -> SigningKey {
    SigningKey::from_bytes(&[11u8; 32].into()).unwrap()
}

pub fn address_of(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let h = near_sdk::env::keccak256_array(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&h[12..]))
}

pub fn sign_message(key: &SigningKey, message: &str) -> String {
    let digest = eip191_digest(message);
    let (sig, rec) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    format!("0x{}", hex::encode(out))
}

pub fn message_for(contract: &str, fund: &str, loan: &str, asset: &str, nonce: &str, expiry_ms: u64) -> String {
    pledge_message(contract, &network_of(contract), loan, fund, asset, nonce, expiry_ms)
}

pub fn sign_pledge(key: &SigningKey, contract: &str, fund: &str, loan: &str, asset: &str, nonce: &str, expiry_ms: u64) -> String {
    sign_message(key, &message_for(contract, fund, loan, asset, nonce, expiry_ms))
}
