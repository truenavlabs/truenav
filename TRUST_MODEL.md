# Trust model

What TrueNav proves, what it assumes, and who can break what. Testnet demo; all data is fictional. Engine-level limits are in `engine/TRUST_MODEL.md`.

## What is proven on chain

| Claim | How | Checked by |
| --- | --- | --- |
| A loan is pledged to one fund at a time | `pledge_loan` locks the loan_hash and mints a non-transferable NEP-171 token; another fund's pledge is refused and counted | contract state, `nft_mint` / `nft_burn` events |
| A loan document matches the fund's claim, without publishing the document | NEAR AI Cloud model TEE signs `"<model>:<sha256(request)>:<sha256(response)>"`; the contract recomputes the response hash, recovers the EIP-191 signer and requires a registered TEE signer for that model | `submit_verdict` |
| A score certificate came from the registered signer and was not edited | EIP-191 signature over a canonical pipe-joined message that includes the contract id; `signed_at` must move forward per fund | `submit_certificate` |
| A fund cannot rename itself to escape its history | `register_fund` binds fund_id to one account and one manager; certificates must match | `submit_certificate` |
| The deployed code is the published source | reproducible build (NEP-330), pinned image digest; the on-chain code hash equals the build hash | anyone, see README "Verify the deployed code" |

## What is trusted (phase 1)

- **The admin account.** It registers certificate signers, TEE signers and funds, and is the servicer that releases loans. One key, held by the deployer. Next: a multisig or DAO admin.
- **TEE signer registration.** The admin registers the model's signing address after checking its attestation off chain with a fresh nonce (`tee/attest.mjs`: Intel TDX quote and TCB status, debug off, signer and nonce bound in the quote, measured config, RTMR3 event log, NVIDIA GPU evidence). The contract does not verify the quote itself. Next: verify the quote inside a TEE (OutLayer) and register from there.
- **The certificate signer is a test key, not TEE.** The engine runs outside any TEE; its certificates are signed by a key held by the operator. The engine is public and deterministic, so anyone can recompute every number from the same inputs. Next: run the engine in a TEE and register that key.
- **NEAR AI Cloud.** A TEE proves which code ran on which hardware, not that the model's judgment is right. The underwriter is an LLM: it can miss a forgery or flag an honest document. Verdicts are evidence, kept with their history; the latest one counts. Instances of the same model share one signing key.
- **Fund-supplied claims and documents.** The TEE compares a document with the fund's claim; a fund that forges both consistently is not caught by this check alone. Cross-fund duplicates are caught by the pledge registry, not by the TEE.

## Privacy

- On chain: loan_hash, pledge holder, verdict and anomaly codes, request and response hashes, certificates with fund totals. Never the document, the borrower or a single loan's amount.
- The loan fingerprint is a demo: `sha256("truenav-demo-v1|" + asset type + "|" + document id)`. It is guessable for real identifiers. Next: an HMAC whose key never leaves a TEE (OutLayer).
- Blocked attempts and alerts are public state. They never name the other fund, but they are not private.
- The underwriter request (document plus claim) is sent to NEAR AI Cloud over TLS; NEAR AI Cloud's private-inference guarantees apply. This repo keeps no document server-side; the demo documents are fictional and committed.

## Not claimed

Not zero-knowledge. Not fair value: TrueVal is a model estimate. Not a credit rating: the TrueNav score is trust in the reported NAV. PD tables are "demo, not calibrated"; LGD is "inference from a corporate stress table; KBRA methodology does not address CRE CLOs".
