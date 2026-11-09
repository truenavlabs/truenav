// RT2-01. The derivation string is the formula in OutLayer's encryption-keys doc, written here.
// Inputs come from the two manifests and from receipts/deploy-testnet.mjs, not from a helper the modules share.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FP_PROJECT, FP_CALLER, FP_KEY_PATH} from '../fingerprint.mjs';

const documented = (bind, project, caller, account, path) =>
  `encryption-key:v1:${bind}:${project}:${caller}:${account}:${path}`;

const manifest = (p) => JSON.parse(readFileSync(new URL(`../../${p}/manifest.json`, import.meta.url)));
const keyOf = (m, path) => {
  const k = m.encryption_keys.find((x) => x.path === path);
  assert.ok(k, path);
  return { path: k.path, bind: k.bind ?? 'project', caller: k.caller ?? 'signer' };
};

test('loan-terms-v2 scope is the documented formula applied to both manifests and the deploy script', () => {
  const deploy = readFileSync(new URL('../../receipts/deploy-testnet.mjs', import.meta.url), 'utf8');
  const master = deploy.match(/TRUENAV_MASTER \|\| "([^"]+)"/)[1];
  const receipts = `receipts.${master}`;
  const project = `${receipts}/truenav-engine`;
  assert.match(deploy, /project_id: `\$\{ids\.receipts\}\/truenav-engine`/);
  const pledge = keyOf(manifest('outlayer/fingerprint'), 'loan-terms-v2');
  const engine = keyOf(manifest('outlayer/engine-v3'), 'loan-terms-v2');
  assert.deepEqual(pledge, engine);
  assert.equal(pledge.bind, 'project');
  assert.equal(pledge.caller, 'predecessor');
  const scope = documented(pledge.bind, project, pledge.caller, receipts, pledge.path);
  assert.equal(scope, documented('project', project, 'predecessor', receipts, 'loan-terms-v2'));
  assert.equal(FP_PROJECT, project);
  assert.equal(FP_CALLER, receipts);
  assert.equal(FP_KEY_PATH, pledge.path);
  assert.equal(scope, 'encryption-key:v1:project:receipts.tnlab-718ca9.testnet/truenav-engine:predecessor:receipts.tnlab-718ca9.testnet:loan-terms-v2');
});
