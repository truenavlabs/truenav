// Red team round 2. RT2-01: the pledge module and the NAV check must MAC under ONE OutLayer key.
// OutLayer derives every encryption key as
//   HMAC-SHA256(master, "encryption-key:v1:{project|wasm}:{project_uuid|wasm_sha256}:{caller}:{account_id}:{path}")
// (https://skills.outlayer.ai/building-outlayer-apps/references/encryption-keys.md).
// The path is only one of five inputs. Project ids stand in for the on-chain uuids.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FP_PROJECT, FP_CALLER, FP_KEY_PATH} from '../fingerprint.mjs';

const manifest = (p) => JSON.parse(readFileSync(new URL(`../../${p}/manifest.json`, import.meta.url)));
const scope = (m, path, project, account) => {
  const k = m.encryption_keys.find((x) => x.path === path);
  assert.ok(k, `${path} not declared`);
  return `encryption-key:v1:${k.bind ?? 'project'}:${project}:${k.caller ?? 'signer'}:${account}:${path}`;
};

test('redteam_r2 RT2-01 pledge module and NAV engine must derive the same loan-terms-v2 key', () => {
  const deploy = readFileSync(new URL('../../receipts/deploy-testnet.mjs', import.meta.url), 'utf8');
  assert.match(deploy, /project_id: `\$\{ids\.receipts\}\/truenav-engine`/);
  const engineProject = 'receipts.tnlab-718ca9.testnet/truenav-engine';
  const engine = scope(manifest('outlayer/engine-v3'), 'loan-terms-v2', engineProject, 'receipts.tnlab-718ca9.testnet');
  const module = scope(manifest('outlayer/fingerprint'), FP_KEY_PATH, FP_PROJECT, FP_CALLER);
  assert.equal(module, engine, 'the loan_hash the registry locks and the hash the NAV check looks up come from two different keys');
  assert.match(module, /:predecessor:receipts\.tnlab-718ca9\.testnet:loan-terms-v2$/);
});
