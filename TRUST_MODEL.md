# Trust model

What TrueNav proves, what it assumes, and who can break what. Testnet demo; all data is fictional. Engine-level limits are in `engine/TRUST_MODEL.md`.

## What is proven on chain

| Claim | How | Checked by |
| --- | --- | --- |
| A loan is pledged to one fund at a time | `pledge_loan` requires the registered servicer key over `truenav-pledge-v1` (this contract, this network, loan hash, fund account, asset type, nonce, expiry). It locks the loan_hash and mints a non-transferable NEP-171 token. Another fund's pledge is refused with `already pledged elsewhere`. That refusal is a valid signed pledge from the fund it names, so the contract stores one blocked attempt (`attempt-N`) and one alert, both at the block time and under the refused fund's id; the holder's records are not changed (`contract/src/lib.rs` `pledge_loan`, test `redteam_r2_squat_does_not_penalise_the_real_holder`). Only a call whose caller is not the fund named in the signature stores nothing: no attempt, no alert, no nonce. When a ticket signer is registered, the same message also needs that signer's ticket | contract state, `nft_mint` / `nft_burn` events |
| A loan document matches the fund's claim, without publishing the document | NEAR AI Cloud model TEE signs `"<model>:<sha256(request)>:<sha256(response)>"`; the contract recomputes the response hash, recovers the EIP-191 signer, requires a registered TEE signer for that model, the servicer as submitter, a pledged loan, and a reply bound to this contract, network, version and an unexpired 30-day window | `submit_verdict` |
| The TEE signing key runs in an attested TEE | the attestation report is published; its hash is stored with the TEE signer on chain; anyone re-checks the TDX quote and TCB status, debug mode off, the key and nonce binding, MRCONFIGID and RTMR3 for consistency with the report's own `app_compose` and event log, and the NVIDIA NRAS verdict. MRTD and RTMR0 to RTMR2 are not pinned to expected values, and the NRAS token signature is not verified (README, Known limits and disclosures) | `npm run verify:attestation` |
| A score certificate came from the registered signer and was not edited | EIP-191 signature over a canonical pipe-joined message that includes the contract id; `signed_at` must move forward per fund | `submit_certificate` |
| A fund cannot rename itself to escape its history | `register_fund` binds fund_id to one account and one manager; certificates must match | `submit_certificate` |

Not proven on chain: that the deployed registry code is this source. The live registry `registry.tnlab-368aa2.testnet` is a host build (364904 bytes, code hash `9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o`); `contract_source_metadata` has `build_info` null and the wasm embeds local build paths, so nobody can rebuild it to the same hash today. A reproducible registry build is future work. See the NEP-330 row in [README: How NEAR is used](README.md#how-near-is-used).

## Pledge tickets

A pledge always needs the servicer signature described above. The signature is checked on chain with `recover_address` (EIP-191, secp256k1). Used messages are stored, so the same nonce and tuple cannot be replayed. An expired signature is rejected. A signature for another contract account or another network does not verify here, because the contract builds the message from its own account id and network.

Separately, the registrar may register one or more pledge-ticket signers. Registration stores the signer's address and the sha256 of that signer's OutLayer attestation evidence. `npm run verify:pledge-signer` re-checks a local evidence file against that hash and the recorded address and TCB field. Anyone can run it.

The first `add_pledge_signer` call sets `ticket_required`, and nothing clears it: `remove_pledge_signer` removes the address only (`contract/src/lib.rs`). While `ticket_required` is set, `pledge_loan` also requires a ticket signature over the same message, recovered to a registered ticket signer, so removing the last ticket signer makes every new pledge fail with `ticket signer not registered` until another is added. Before any ticket signer has been registered, the servicer signature is enough. The live registry has no ticket signer registered (`get_pledge_signers` is empty). A TEE verdict signer is a different registry. A model signature is not a pledge ticket.

The fingerprint module can compose that same message from the loan hash it just computed and sign it with the manifest secp256k1 key `pledge-ticket` (`bind: project`, `caller: predecessor`). It does not sign caller-supplied bytes or digests. The unit tests use a local test key standing in for that TEE key. That key is not a TEE key.

What is claimed: the ticket signature is checked on chain. The evidence hash is stored on chain. Anyone can re-check the evidence file.

What is not claimed: the chain does not verify hardware. This is not trustless. The ticket does not prove that a TEE holds the loan. The servicer still decides who may pledge. The publisher can ship a different module version under the same project-bound key. A refreshed NEAR AI Cloud attestation for Qwen is not claimed here.

## What is trusted (phase 1)

- **The role holders.** Admin (roles, fund allowlist), registrar (certificate and TEE signers), pauser and servicer (releases, TEE verdicts) are separate roles; on the live testnet instance `registry.tnlab-368aa2.testnet` (testnet RPC `get_roles` and `view_access_key_list`, 12 Nov 2026) admin and registrar are `tnlab-368aa2.testnet`, pauser is `pauser.tnlab-368aa2.testnet` and servicer is `servicer.tnlab-368aa2.testnet`; the contract account has 1 full-access key and no function-call keys, and that key is the upgrade authority. The servicer decides which verdicts to submit and can re-run the TEE until it gets a pass: TEE runs it never submits are invisible on chain, and no contract can log a run it never receives (the flag rule is a speed bump, not a lock). Our own tooling retries only when a reply fails its local checks (a miscopied echo or the reply rule), never because of a flag, and records every try with its request and response hashes in the published verdict set (`tries` in `tee/fixtures/verdicts.json`); a real deployment needs an independent servicer or every TEE run committed on chain. Code upgrades need the contract account's full-access key. Next: multisig or DAO control and an independent servicer.
- **TEE signer registration.** The registrar registers the model's signing address together with the hash of the published attestation report, after checking it with a fresh nonce. Anyone can repeat the check with `npm run verify:attestation`; the contract does not verify the quote itself. Next: verify the quote on chain or inside a TEE (OutLayer).
- **The certificate signer is a test key, not TEE.** The engine runs outside any TEE; its certificates are signed by a key held by the operator. The engine is public and deterministic, so anyone can recompute every number from the same inputs. Next: run the engine in a TEE and register that key.
- **NEAR AI Cloud.** A TEE proves which code ran on which hardware, not that the model's judgment is right. The underwriter is an LLM: it can miss a forgery or flag an honest document. Verdicts are evidence, kept with their history; the latest one counts. Instances of the same model share one signing key.
- **Fund-supplied claims and documents.** The TEE compares a document with the fund's claim; a fund that forges both consistently is not caught by this check alone. Cross-fund duplicates are caught by the pledge registry, not by the TEE.

## Privacy

- On chain: loan_hash, pledge holder, asset type (pledge token metadata and the `pledge_loan` arguments), verdict and anomaly codes, request and response hashes, certificates with fund totals, and timestamps (pledge time, verdict submit time and expiry, attempt and alert times, certificate `signed_at`). The document text is not on chain.
- What that still reveals: the request hash is sha256 of the whole request, and the request holds the document text, the document id, the asset, the loan hash, the binding and the claimed amount, with no salt (`tee/underwrite.mjs` `buildRequest`). Anyone who holds the document can rebuild the request, try amounts until the hash matches, and so recover the claimed amount and link the document to its loan hash and to the fund that pledged it. A fund that holds one loan exposes that loan's figures through its certificate totals.
- Public transaction data: each `submit_verdict` call publishes the whole signed TEE reply, even when the call fails. The reply may hold only the allowed keys (`tee/reply.mjs`): the loan hash, the binding, the six check results (ok or fail), the duplicate evidence line number, the verdict and the anomaly codes. The client rejects any other key or value, and CI decodes every `submit_verdict` transaction on the live contract (`npm run check:chain-replies`). The contract enforces, before it checks the signature: a body of at most 4096 bytes; valid JSON with no repeated key anywhere; exactly one choice; no non-null message field beside `role` and `content`; content that is one JSON object (one optional code fence removed) with no repeated key and only the allowed keys; a 64-hex loan hash, a binding of allowed characters, `ok` or `fail` checks, an evidence line of 1 to 10000 or `ok`, a `pass` or `flag` verdict and known anomaly codes (`reply_problem`). It does not check the outer reply fields `id`, `object`, `created`, `model`, `usage`, `finish_reason`, `logprobs` or `index`; the client (`tee/reply.mjs`) and CI do. The line number points into the private document; nobody outside the TEE can check it from chain, only the eval, which has the documents.
- Found and fixed on 7 Nov: on the earlier instance `registry.tnlab-dd2a56.testnet`, 15 of 20 `submit_verdict` transactions carried the document id, asset and amount (fictional data; see AUDIT_FINDINGS 21). The current instance never received such a reply.
- The loan fingerprint is HMAC under key path `loan-terms-v2` of the length-prefixed `truenav-fp-v4` preimage (asset class, collateral namespace, document id). OutLayer derives that key as HMAC-SHA256(master, "encryption-key:v1:{project|wasm}:{project_uuid|wasm_sha256}:{caller}:{account_id}:{path}"). Both the fingerprint module and the NAV engine declare bind `project`, caller `predecessor`, path `loan-terms-v2`, project `receipts.<master>/truenav-engine`, and account the receipts contract. The HTTPS call sends `version_key` equal to the pinned fingerprint wasm so OutLayer does not run the engine build that is the project's active version. A case-sensitive namespace keeps the namespace and document case on both sides. Default namespaces still casefold. Historical v1 locks used a different path and project and are not aliased. A live run is still required to confirm the on-chain project uuid and that the payment key owner is the receipts account.
- **Who can produce the shared fingerprint.** The predecessor account in the derivation is the receipts contract, not a fund and not the old servicer project. A fund payment key derives a different key. The operator still sees document identifiers when a fingerprint is requested. A stored `attestation_ref`, including a non-empty one, is not a verified TEE pass. The agent and the API say `unattested` until a real proof check accepts the receipt. They do not approve on the receipt hash or the engine hash alone.
- Document ids are canonical (uppercase A to Z, digits, hyphen, 1 to 128 characters) unless the namespace is case-sensitive, in which case ASCII mixed case is kept and must match the engine lookup. Nothing else is rewritten.
- Shipped contract wasm uses Rust's built-in allocator. `near-sdk` is built with `default-features = false`, so `wee_alloc` is not linked. `lol_alloc` is not a dependency.
- The API spend store is one directory on one machine. See the runbook in `SECURITY.md`. Several API processes on that machine share one lock. Two machines, or two copies of the directory, do not. The per-IP limiter uses the socket address. `X-Forwarded-For` is ignored unless `TRUENAV_TRUST_PROXY=1`. That flag is off by default. A reverse proxy in front of the API is one shared address until an operator turns the flag on and trusts that proxy.
- Blocked attempts and alerts are public state, stored under the refused fund's id. They never name the other fund, but they are not private.
- The underwriter request (document plus claim) is sent to NEAR AI Cloud over TLS; NEAR AI Cloud's private-inference guarantees apply. This repo keeps no document server-side; the demo documents are fictional and committed.

## Further disclosures (red-team final pass, 13 Nov 2026)

| Item | What is true today | Where |
| --- | --- | --- |
| Unsalted request hash | `request_sha256` is sha256 of the request with no salt, so a document holder can test guesses against it (Privacy above). A salt would stop that, but the servicer would then have to keep every salt for as long as an auditor may need to recompute the hash. | `tee/underwrite.mjs` `buildRequest` |
| Token counts in the signed reply | The signed body carries `usage` (for example `prompt_tokens` 803 in the 368aa2 set), which reveals the document's length. It cannot be stripped: the TEE signature covers sha256 of the exact body, so any edit fails the signature check. | `tee/fixtures/verdicts-368aa2.json`, `submit_verdict` |
| Who chooses the prompt | The servicer builds the request; only its hash is on chain. A signed pass proves that the attested model replied to a request with that hash, not that our system prompt was in it. Anyone who holds the document can rebuild the request from `tee/underwrite.mjs` and compare the hash. | `submit_verdict` |
| Verdict expiry window | The servicer writes the expiry into the binding when it builds the request. The contract reads the time only at submit: it needs `now <= expires_at_ms <= now + 30 days + 1 hour`, where now is the submit block time. It never reads when the TEE ran, so a signed reply can be held and submitted later, as long as the submit falls in that window, and the stored verdict then counts until `expires_at_ms`. | `contract/src/lib.rs` `submit_verdict` |
| Fingerprint queries by an authorized caller | The fingerprint key stays inside the OutLayer TEE, but a caller that is allowed to use the service can request a fingerprint for any guessed asset class, namespace and document id and compare it with on-chain loan hashes. This repo adds no rate limit and no query log for that. | `tee/fingerprint.mjs`, `outlayer/fingerprint` |
| Signer removal | `remove_tee_signer` removes the address from the signer list only. Verdicts already stored under that signer stay, `get_latest_verdict` still returns them, and clients still count them until they expire. | `contract/src/lib.rs` |
| Prompt injection coverage | 16 synthetic injection cases in 10 styles were run once each (`tee/eval/REPORT.md`): direct, reviewer note, role play, fake JSON, obfuscated and other language in the main set, and hidden footer, polite request, fake policy and markdown in the hold-out set. Other variants are not tested, for example encoded text, zero-width or lookalike characters, a fake end-of-document marker, instructions split over many lines, and injections that aim for a false flag on an honest document. | `tee/eval` |
| Spend store restore | Restoring `state.json` from a backup brings back the nonce list as it was at backup time. Nonces spent after that backup are forgotten, so their spend proofs can be replayed until they expire (at most 5 minutes after signing, `SPEND_TTL_MS`). | `api/server.mjs`, `SECURITY.md` runbook |

## Cashflow receipt mirror (Base Sepolia)

The implementation is not deployed and no live mirror run has been verified. The sections above describe the
historical registry path; this section concerns the cashflow-v2.1.0 receipts contract and short-receipt mirror.

The NEAR contract constructs the only payload it can sign from a receipt it already stored: chain 84532, the
configured mirror address, the single update selector, zero value, fixed gas limit, contract-serialized nonce and
bounded fees. It does not accept arbitrary signing payloads. The stored hash binds the callback-delivered receipt
bytes, not an independently canonicalized report, signed PDF or attestation proof. The mirror publishes only token
hash, sequence, receipt hash, score, band, method hash and timestamp; caps, holds and full evidence remain referenced
by the NEAR receipt. All data is synthetic.

The mirror address and the derived key are admin configuration. `set_mirror_config` (admin only, one yoctoNEAR,
unpaused; `receipts/src/mirror.rs:198-224`) sets the mirror address and can later repoint it to any non-zero
address whenever no nonce is pending; every update signed after that goes to the new address. The derived
`public_key` in that config is taken on the admin's word: the contract checks only its length, not that it is the
MPC network's derivation for this account. The operator scripts (`mirror/broadcast.mjs`, `mirror/confirm.mjs`) read
both from `get_mirror_config`, check the key against the signer's own derivation (`mirror/derive.mjs`), and stop if
an address given on the command line differs.

Base trusts the MPC network's derived signing key and the NEAR contract that requests its signatures. It does not
verify NEAR consensus, OutLayer attestation or bank evidence. The Solidity contract's MPC address is immutable, and
only it may update state, with a strictly increasing sequence per token. Anyone can relay the already-signed bytes;
the relayer cannot change their recipient, chain, nonce or contents without invalidating the signature.

NEAR trusts the admin for Base finality. The dev-admin confirmer waits for successful execution, the Base
`finalized` block tag and a matching canonical receipt block before calling `confirm_mirror(nonce, tx_hash)`.
The NEAR method requires the admin, one yoctoNEAR, an unpaused contract, the pending nonce and the exact Keccak-256
hash of a stored signed transaction for it. Only then is the next nonce released. This is an admin assertion backed
by the configured RPC, not an on-chain verification of Base finality. The confirmer reads every finality fact
(receipt, finalized block, canonical block hash) from that one Base RPC, `BASE_RPC_URL`; a second, independent RPC
check is future hardening, not built. A false confirmation can only stall or skip a
mirror update, never forge one, since the mirror contract accepts only MPC-signed updates with strictly increasing
sequence. That guarantee assumes the deployed NEAR signing restrictions remain intact: its upgrade authority and
admin configuration are trusted. A compromised upgrade authority can replace those restrictions.

An unconfirmed nonce blocks the lane. Signer or relayer outages, insufficient Base gas balance, a stale sequence,
the fee cap or the bounded 16-attempt signing history can stall it. Re-signing keeps the nonce and immutable payload
and raises only fees; any stored replacement can be confirmed if it is the one finalized.
An admin-only, one-yocto, unpaused `clear_mirror_signing` call can clear a stuck signing flag, but cannot alter the
nonce or payload, confirm finality, or bypass retry limits. Late callbacks cannot overwrite a newer attempt.
There is no skip or cancel for a pending nonce: `set_mirror_config` refuses while one is pending, and
`confirm_mirror` needs the hash of a stored signed attempt. Once all 16 attempts (`MAX_ATTEMPTS`) are used and none
lands, `clear_mirror_signing` does not help (it clears only the signing flag and keeps the attempt limit), so only a
contract upgrade unblocks the lane. The derived account pays
only testnet ETH gas. The NEAR contract's balance pays mirror storage and the signer deposit, under admin control.
The mirror neither controls investment funds nor changes any score when someone pays for access.

## Not claimed

Not zero-knowledge. Not fair value: TrueVal is a model estimate. Not a credit rating: the TrueNav score is trust in the reported NAV. PD tables are "demo, not calibrated"; LGD is "inference from a corporate stress table; KBRA methodology does not address CRE CLOs".
