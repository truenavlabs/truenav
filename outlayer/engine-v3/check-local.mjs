// Local-only backend gate. No network clients, keys, deployments or transactions.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
if(process.env.CI&&process.argv.includes('--regenerate-test-vectors'))throw new Error('CI must not regenerate vectors');
const root=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args,env={}){const r=spawnSync(command,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});if(r.error){console.error('Backend check could not start');process.exit(1);}if(r.status!==0)process.exit(r.status??1);}
run('cargo',['+1.99.0','test','--locked','--manifest-path','engine/v3-core/Cargo.toml']);
run('cargo',['+1.99.0','test','--locked','--manifest-path','engine/v3-core/Cargo.toml','--features','dry-run-tests']);
run('node',['outlayer/engine-v3/build-pinned.mjs']);
const wasm=path.join(root,'outlayer/engine-v3/target/pinned/wasm32-wasip2/release/truenav-engine-v3.wasm');
const engineHash=createHash('sha256').update(readFileSync(wasm)).digest('hex');
run('cargo',['+1.99.0','test','--locked','--manifest-path','outlayer/engine-v3/Cargo.toml'],{TRUENAV_TEST_ENGINE_SHA256:engineHash,...(process.argv.includes('--regenerate-test-vectors')?{TRUENAV_WRITE_DERIVED_VECTORS:'1'}:{})});
console.log('DRY_RUN: explicit dev-account engine tests; normal frozen validation must reject their envelopes');
run('cargo',['+1.99.0','test','--locked','--manifest-path','outlayer/engine-v3/Cargo.toml','--features','dry-run-tests']);
for(const file of ['receipt-v3-schema.test.py','receipt-v3.0.1-schema.test.py','receipt-v3-privacy.test.py','engine-v3-privacy.test.py'])run('python3',[`receipts/tests/${file}`]);
run('node',['--test','receipts/tests/receipt-v3-interface.test.mjs','receipts/attestation/match.test.mjs','receipts/attestation/source-registry.test.mjs','receipts/attestation/output-parity.test.mjs']);
run('npm',['run','receipt:v3:pins']);
run('cargo',['+1.99.0','test','--locked','--manifest-path','receipts/Cargo.toml']);
console.log('DRY_RUN: explicit dev-account contract tests; overlay is not a production/verifier default');
run('cargo',['+1.99.0','test','--locked','--manifest-path','receipts/Cargo.toml','--features','dry-run-tests']);
run('node',['receipts/attestation/check-protocol.mjs','--recorded']);
console.log(`Backend gates passed, engine wasm sha256 ${engineHash}`);
