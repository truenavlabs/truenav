// Exact OutLayer worker serialization, tested with Rust serde_json defaults in an isolated crate.
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {bodyOf,canonical,sha} from './match-core.mjs';
const read=p=>JSON.parse(readFileSync(new URL('../../'+p,import.meta.url)));
test('OutLayer serde_json::to_string(returned B) output_hash equals the stored body_sha256',()=>{
 const cases=[];
 for(const v of [...read('schema/vectors/receipt-v3-golden.json').vectors,...read('schema/vectors/engine-v3-derived.json').vectors,...read('schema/vectors/engine-v3-derived.json').conflict_cases])cases.push({name:v.name,body_bytes:canonical(bodyOf(v.envelope))});
 for(const v of read('schema/vectors/engine-v3-derived.json').temporal_cases)for(const k of ['before','after'])cases.push({name:v.name+'_'+k,body_bytes:canonical(bodyOf(v[k]))});
 // Not a receipt: a sentinel proves the helper performs the worker's sorting rather than hashing stdin unchanged.
 cases.push({name:'TEST_noncanonical_sentinel',body_bytes:'{"z":1,"a":2}'});
 const run=spawnSync('cargo',['+1.99.0','run','--quiet','--locked','--manifest-path','receipts/tests/outlayer-output-parity/Cargo.toml'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const rows=JSON.parse(run.stdout);assert.equal(rows.length,cases.length);
 for(let i=0;i<cases.length-1;i++){assert.equal(rows[i].body_sha256,sha(cases[i].body_bytes));assert.equal(rows[i].output_sha256,rows[i].body_sha256,cases[i].name);assert.equal(rows[i].equal,true);}
 assert.equal(rows.at(-1).equal,false);assert.notEqual(rows.at(-1).output_sha256,rows.at(-1).body_sha256);
});
