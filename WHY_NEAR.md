# Why NEAR

TrueNav needs three things in one place: a registry no fund controls, private computation whose output a contract can check, and low-cost writes for every pledge and verdict. NEAR gives all three.

- **TEE inference with a verifiable signer.** NEAR AI Cloud runs open models inside Intel TDX and NVIDIA confidential computing and returns attestation bound to a client nonce, plus an ECDSA signature over each request and response hash ([verification docs](https://docs.near.ai/cloud/verification)). The registry checks that signature with `env::ecrecover`, so a private document check becomes a public, verifiable verdict.
- **Pledges as standard tokens.** Each pledged loan is a NEP-171 token minted on first pledge and burned on release ([NFT standard](https://docs.near.org/primitives/nft/standard)). Wallets and explorers see pledges through the standard events and enumeration views.
- **Access keys.** Function-call keys cannot attach a deposit, so requiring one yoctoNEAR on admin, servicer and pledge calls means only a full-access key can make them ([access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)).
- **Verifiable code.** Reproducible builds with NEP-330 source metadata let anyone match the deployed code hash to the source ([reproducible builds](https://docs.near.org/smart-contracts/anatomy/reduce-size)).
- **Sub-accounts.** Each run creates `registry.`, `harbor.` and `meridian.` under one account, which keeps a judge's own deployment isolated and cheap.

Next on NEAR: an HMAC loan fingerprint whose key never leaves a TEE (OutLayer), and a certificate mirror to EVM chains through Chain Signatures ([chain signatures](https://docs.near.org/chain-abstraction/chain-signatures/getting-started)) so investors on other chains can read the same proof.
