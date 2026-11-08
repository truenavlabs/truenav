# Trust model

What TrueNav proves, what it assumes, and who can break what. Testnet demo; all data is fictional. Engine-level limits are in `engine/TRUST_MODEL.md`.

## What is proven on chain

| Claim | How | Checked by |
| --- | --- | --- |
| A loan is pledged to one fund at a time | `pledge_loan` locks the loan_hash and mints a non-transferable NEP-171 token; another fund's pledge is refused and counted | contract state, `nft_mint` / `nft_burn` events |
| A loan document matches the fund's claim, without publishing the document | NEAR AI Cloud model TEE signs `"<model>:<sha256(request)>:<sha256(response)>"`; the contract recomputes the response hash, recovers the EIP-191 signer, requires a registered TEE signer for that model, the servicer as submitter, a pledged loan, and a reply bound to this contract, network, version and an unexpired 30-day window | `submit_verdict` |
| The TEE signing key runs in an attested TEE | the attestation report is published; its hash is stored with the TEE signer on chain; anyone re-checks the TDX quote, key and nonce binding, measurements and GPU evidence | `npm run verify:attestation` |
| A score certificate came from the registered signer and was not edited | EIP-191 signature over a canonical pipe-joined message that includes the contract id; `signed_at` must move forward per fund | `submit_certificate` |
| A fund cannot rename itself to escape its history | `register_fund` binds fund_id to one account and one manager; certificates must match | `submit_certificate` |
| The deployed code is the published source | reproducible build (NEP-330), pinned image digest; the on-chain code hash equals the build hash | anyone, see README "Verify the deployed code" |

## What is trusted (phase 1)

- **The role holders.** Admin (roles, fund allowlist), registrar (certificate and TEE signers), pauser and servicer (releases, TEE verdicts) are separate roles; on the live testnet instance admin, registrar and pauser are the owner's account (`truenav-admin.testnet`, key on the owner's machine only) and the servicer is an operator account; the contract account holds the owner's full-access key and an operator backup key, to be removed before the repository goes public (owner decision 7 Nov). The servicer decides which verdicts to submit and can re-run the TEE until it gets a pass: TEE runs it never submits are invisible on chain, and no contract can log a run it never receives (the flag rule is a speed bump, not a lock). Our own tooling retries only when a reply fails its local checks (a miscopied echo or the reply rule), never because of a flag, and records every try with its request and response hashes in the published verdict set (`tries` in `tee/fixtures/verdicts.json`); a real deployment needs an independent servicer or every TEE run committed on chain. Code upgrades need the contract account's full-access key. Next: multisig or DAO control and an independent servicer.
- **TEE signer registration.** The registrar registers the model's signing address together with the hash of the published attestation report, after checking it with a fresh nonce. Anyone can repeat the check with `npm run verify:attestation`; the contract does not verify the quote itself. Next: verify the quote on chain or inside a TEE (OutLayer).
- **The certificate signer is a test key, not TEE.** The engine runs outside any TEE; its certificates are signed by a key held by the operator. The engine is public and deterministic, so anyone can recompute every number from the same inputs. Next: run the engine in a TEE and register that key.
- **NEAR AI Cloud.** A TEE proves which code ran on which hardware, not that the model's judgment is right. The underwriter is an LLM: it can miss a forgery or flag an honest document. Verdicts are evidence, kept with their history; the latest one counts. Instances of the same model share one signing key.
- **Fund-supplied claims and documents.** The TEE compares a document with the fund's claim; a fund that forges both consistently is not caught by this check alone. Cross-fund duplicates are caught by the pledge registry, not by the TEE.

## Privacy

- On chain: loan_hash, pledge holder, verdict and anomaly codes, request and response hashes, certificates with fund totals. Never the document, the borrower or a single loan's amount.
- Public transaction data: each `submit_verdict` call publishes the whole signed TEE reply, even when the call fails. The reply may hold only the allowed keys (`tee/reply.mjs`): the loan hash, the binding, the six check results (ok or fail), the duplicate evidence line number, the verdict and the anomaly codes. The client rejects any other key or value, the contract refuses such a reply before anything else, and CI decodes every `submit_verdict` transaction on the live contract (`npm run check:chain-replies`). The line number points into the private document; nobody outside the TEE can check it from chain, only the eval, which has the documents.
- Found and fixed on 7 Nov: on the earlier instance `registry.tnlab-dd2a56.testnet`, 15 of 20 `submit_verdict` transactions carried the document id, asset and amount (fictional data; see AUDIT_FINDINGS 21). The current instance never received such a reply.
- The loan fingerprint is `HMAC-SHA256(key, "truenav-fp-v1|" + asset type + "|" + document id)`, computed by the OutLayer TEE module `outlayer/fingerprint` (owner decision D1, 7 Nov). The key is derived inside the TEE for the project and the calling account and never leaves it; nobody, including the operator and OutLayer, can recompute a fingerprint or test a guess. Every run's attestation is public: the pinned wasm, the input and output hashes and an Intel TDX quote (`npm run verify:fingerprints`). Requests go over HTTPS (on chain the input would be public) with a random nonce, so the attestation's input hash is not guessable either.
- **Trust shift: the servicer is the one place fingerprints come from.** Because the TEE derives the key per calling account, only the servicer's account produces the shared fingerprint that makes a second fund's pledge collide. Funds ask the servicer for the fingerprint of each loan; the servicer sees the document identifiers (it already reads every document for the TEE underwriter). A servicer that refused a fund, or gave two funds fingerprints from different accounts, would break the double-pledge check for that loan; the attestation shows which account ran each fingerprint. Next: an independent servicer, or fingerprints requested by the registry contract itself with encrypted input.
- Document ids must be canonical (uppercase A to Z, digits, hyphen, 1 to 128 characters). The OutLayer TEE fingerprint module and the JS client both refuse any other id; nothing is rewritten.
- Blocked attempts and alerts are public state. They never name the other fund, but they are not private.
- The underwriter request (document plus claim) is sent to NEAR AI Cloud over TLS; NEAR AI Cloud's private-inference guarantees apply. This repo keeps no document server-side; the demo documents are fictional and committed.

## Cashflow receipt mirror (Base Sepolia)

The implementation is not deployed and no live mirror run has been verified. The sections above describe the
historical registry path; this section concerns the cashflow-v2.1.0 receipts contract and short-receipt mirror.

The NEAR contract constructs the only payload it can sign from a receipt it already stored: chain 84532, the
configured mirror address, the single update selector, zero value, fixed gas limit, contract-serialized nonce and
bounded fees. It does not accept arbitrary signing payloads. The stored hash binds the callback-delivered receipt
bytes, not an independently canonicalized report, signed PDF or attestation proof. The mirror publishes only token
hash, sequence, receipt hash, score, band, method hash and timestamp; caps, holds and full evidence remain referenced
by the NEAR receipt. All data is synthetic.

Base trusts the MPC network's derived signing key and the NEAR contract that requests its signatures. It does not
verify NEAR consensus, OutLayer attestation or bank evidence. The Solidity contract's MPC address is immutable, and
only it may update state, with a strictly increasing sequence per token. Anyone can relay the already-signed bytes;
the relayer cannot change their recipient, chain, nonce or contents without invalidating the signature.

NEAR trusts the admin for Base finality. The dev-admin confirmer waits for successful execution, the Base
`finalized` block tag and a matching canonical receipt block before calling `confirm_mirror(nonce, tx_hash)`.
The NEAR method requires the admin, one yoctoNEAR, an unpaused contract, the pending nonce and the exact Keccak-256
hash of a stored signed transaction for it. Only then is the next nonce released. This is an admin assertion backed
by the configured RPC, not an on-chain verification of Base finality. A false confirmation can only stall or skip a
mirror update, never forge one, since the mirror contract accepts only MPC-signed updates with strictly increasing
sequence. That guarantee assumes the deployed NEAR signing restrictions remain intact: its upgrade authority and
admin configuration are trusted. A compromised upgrade authority can replace those restrictions.

An unconfirmed nonce blocks the lane. Signer or relayer outages, insufficient Base gas balance, a stale sequence,
the fee cap or the bounded 16-attempt signing history can stall it. Re-signing keeps the nonce and immutable payload
and raises only fees; any stored replacement can be confirmed if it is the one finalized. The derived account pays
only testnet ETH gas. The NEAR contract's balance pays mirror storage and the signer deposit, under admin control.
The mirror neither controls investment funds nor changes any score when someone pays for access.

## Not claimed

Not zero-knowledge. Not fair value: TrueVal is a model estimate. Not a credit rating: the TrueNav score is trust in the reported NAV. PD tables are "demo, not calibrated"; LGD is "inference from a corporate stress table; KBRA methodology does not address CRE CLOs".
