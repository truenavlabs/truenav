# Receipts live run: plan

Plan only. Nothing in this file has been run. No deploy, transaction, OutLayer upload or secret is involved in writing it. The aim is to say how a fresh OutLayer run relates to the loan hashes already pledged on `registry.tnlab-368aa2.testnet`, and the cleanest honest way to show a live receipt next to them.

Labels used below: **repo** means a statement checked against a file in this repository. **unverified** means it comes from the handoff or from memory of an earlier run and has not been re-checked here.

## 1. What exists today

| Item | State | Source |
| --- | --- | --- |
| Pledged demo loans on the current registry `registry.tnlab-368aa2.testnet` | The registry holds the demo funds. `npm run chain:read` recomputes Harbor 99 green and Meridian 43 red against it. Whether every one of the 19 demo `loan_hash` values is pledged there was not re-read for this plan. | repo (README); pledge coverage **unverified** |
| Recorded loan fingerprints | 17 records in `tee/fixtures/fingerprints.json`, produced by the OutLayer project `servicer.tnlab-718ca9.testnet/truenav-fingerprint`, domain `truenav-fp-v1`, pinned wasm `4a7c0e4e...07e3`. `tee/loans.json` lists 19 loans. | repo |
| Fingerprint client | `tee/fingerprint.mjs` calls project `receipts.tnlab-718ca9.testnet/truenav-engine` (domain `truenav-fp-v4`) and accepts an attestation only if its project and caller are that pair or the recorded `servicer.tnlab-718ca9.testnet` pair. | repo |
| Receipts contract | No live receipts contract on 368aa2. Receipts are synthetic fixtures. | repo (README) |
| Deploy script | `receipts/deploy-testnet.mjs` D0 to D4, print-only by default, master from `--master` or `TRUENAV_MASTER`, no default. | repo (this branch) |
| Pinned builds | receipts `5f294c9a...f52e8606f`, query `dee5f216...8169d09`, reproduced byte for byte by the `receipts-pinned-build` workflow. Still a local build candidate, not deployed. | repo (`receipts/pinned-builds.json`) |

## 2. Why a fresh run cannot reproduce the pledged hashes

A loan hash is an OutLayer MAC of the framed term digest. The MAC key is derived from the OutLayer project, the caller account and the key path (`loan-terms-v2`). The registry refuses a second pledge of the same `loan_hash`, and that only works because the same loan always gives the same hash inside one key scope.

The hashes already pledged were made inside the 718ca9 scope:

- the recorded set, under `servicer.tnlab-718ca9.testnet/truenav-fingerprint`;
- the v4 fingerprint tooling, under `receipts.tnlab-718ca9.testnet/truenav-engine` (hardwired in `tee/fingerprint.mjs` as `FP_PROJECT` and `FP_CALLER`).

A fresh master account (for example `receipts.<fresh-master>/truenav-engine`) is a different project and a different caller, so it is a different key scope. The same loan terms will therefore produce **different** loan hashes there. That has three consequences:

1. A live run under a fresh master can never "confirm" a pledged hash. It cannot match one, and it must not be presented as if it did.
2. `tee/fingerprint.mjs` and `npm run verify:fingerprints` will reject an attestation from the fresh scope, because the project and caller checks only allow the two 718ca9 pairs. This is correct behaviour and should stay: it stops a foreign run being passed off as the recorded set.
3. Re-pledging the demo loans under the fresh scope would put a second hash for the same real-world loan on chain. The registry would accept it, and the point of the pledge (one fund per loan) would be defeated for those loans. Do not do this on 368aa2.

The v3 engine's pledge-conflict amendment (`outlayer/engine-v3/README.md`, v3.0.1) compares loan fingerprints. My reading, not tested, is that a receipt made in the fresh scope would not see a conflict with hashes made in the 718ca9 scope, because the fingerprints differ. That is another reason to keep the two sets visibly separate.

## 3. Options

| Option | What it shows | Cost and risk | Verdict |
| --- | --- | --- | --- |
| A. Live receipt as a separate, labelled block | A real OutLayer run of the pinned receipts engine, under a fresh master, on a synthetic fund. Its own call id, attestation and receipt hash. The recorded pledged set stays untouched and is described as recorded. | Needs a funded fresh testnet account and the owner's `--execute`. No change to 368aa2. | **Recommended** |
| B. Re-run under the 718ca9 master | Same key scope as the pledges, so hashes could match. | 718ca9 held 1.8967 NEAR at the last read-only check (**unverified today**), well under the 8.25 NEAR preflight. Its keys are not available to this repo. Also a used master: `--execute` is refused for it by design. | Not available |
| C. Re-pledge demo loans from the fresh scope | A "fully live" demo on one registry. | Duplicates loan identities on 368aa2; breaks the one-pledge-per-loan story; hashes of the recorded set stop being the evidence. | Do not do |
| D. Stand up a new registry for the fresh scope | A clean second registry where everything is live. | New deploy, new certificate signer, new TEE verdict question. Large, and it competes with the open TEE work. | Only if the owner wants it after A |

## 4. Recommended path (option A)

Steps for the owner's team. I do not run any of them.

1. **Fresh master.** Create a new testnet account that has not been used before. Fund it to at least 8.25 NEAR (D1: receipts 6, query 1.7, runner 0.4, api 0.1 = 8.2, plus a 0.05 gas margin). Keys stay with the owner's team.
2. **Dry run first.** `TRUENAV_MASTER=<fresh-master> node receipts/deploy-testnet.mjs D0`, then the same command with `D1` to `D4`, all without `--execute`. Read the printed funding table, the `new(...)` arguments and the four synthetic tokens. `receipts/tests/deploy-args.test.mjs` already checks this output against a fake RPC.
3. **Pinned wasm only.** Take the two wasm files from the `truenav-pinned-wasm` artifact of a green `receipts-pinned-build` run and check their sha256 against `receipts/pinned-builds.json`. The deploy script refuses anything else. The committed `receipts/dist` is stale and is not used.
4. **Execute D1 to D4** with `--execute`, one step at a time, the owner's team only. Record every transaction hash.
5. **Register and run in OutLayer** (rows O1 to O3 of `receipts/README.md`) under the fresh master. Use synthetic funds only.
6. **Capture the evidence** for one receipt: the receipt body and `receipt_sha256`, the OutLayer call id, the attestation fetched by call id, the pinned wasm sha256 that ran, the project and caller ids, and the transaction hashes from step 4.
7. **Publish it as its own block.** Add a fixture file for the live run (new file, not `tee/fixtures/fingerprints.json`) and a small verifier that checks the same things `verify:fingerprints` checks, against the fresh project and caller. Do this in a later change; it is not part of this one.

## 5. How to word it

Suggested wording for the README and the judge path once step 6 is done. Edit the numbers after the run.

> **Recorded demo set (pledged on `registry.tnlab-368aa2.testnet`).** The loan hashes come from earlier OutLayer runs under the 718ca9 key scope. They are checked by `npm run verify:fingerprints`.
>
> **Live receipt (fresh account, separate key scope).** One receipt produced by the pinned receipts engine on a new testnet account, on a synthetic fund. Its loan hashes differ from the recorded set because the key scope is different. It is not pledged on 368aa2 and is not evidence about the recorded hashes.

Things not to claim:

- that the live run reproduces or confirms any pledged hash;
- that the live receipt is on 368aa2 (there is no receipts contract there);
- anything about TEE verdicts on 368aa2, which stay pending until `tee/status.json` says otherwise (see `docs/TEE_STATUS.md` once that change is merged);
- that the pinned-image build is a NEP-330 verified build. It is a pinned-image build whose output matches the pins.

## 6. Decisions for the owner

1. Go or no-go on option A, and which fresh account name to use.
2. Who funds the 8.25 NEAR and who holds the keys.
3. Whether the live receipt needs its own registry (option D) or stays a standalone block.
4. Whether the fingerprint client should learn a second allowed project and caller pair for the fresh scope, or the live block gets its own small verifier. The second is the smaller and safer change, and is what step 7 assumes.

## 7. Open items

- The Tests-section counts in `receipts/README.md` were not re-verified here (**unverified**).
- Pledge coverage of all 19 loans on 368aa2 was not re-read (**unverified**).
- 718ca9 balance of 1.8967 NEAR was read once, read-only, earlier in this work (**unverified today**).
