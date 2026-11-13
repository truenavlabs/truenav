// Read-only protocol check. Default is offline replay; --fetch reads public proof/collateral, never runs a job.
import {cliGuard,reportNetworkAtExit} from '../../certify/net-guard.mjs'; // first: wraps fetch before @phala/dcap-qvl keeps its own copy
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {getCollateralAndVerify} from '@phala/dcap-qvl';
import {taskHash,quoteFields} from '../../tee/fingerprint.mjs';
import {fetchPublicProof} from './match.mjs';
cliGuard(import.meta.url); // --fetch with OutLayer, PCCS or Intel PCS unreachable: a line naming it, exit 2, no stack trace
const args=process.argv.slice(2);if(args.some(a=>!['--recorded','--fetch'].includes(a))||args.includes('--recorded')&&args.includes('--fetch'))throw new Error('choose --recorded or --fetch');
const read=p=>JSON.parse(fs.readFileSync(new URL('../../'+p,import.meta.url)));
const sample=read('tee/fixtures/fingerprint-attestation-sample.json');
const record=read('tee/fixtures/fingerprints.json').records.find(r=>r.call_id===sample.call_id);
const proof=args.includes('--fetch')?await fetchPublicProof('https://testnet-api.outlayer.ai/attestations/by-call/'+sample.call_id):sample;
let failures=0;const check=(ok,label)=>{console.log((ok?'PASS ':'FAIL ')+label);if(!ok)failures++;};
check(!!record&&createHash('sha256').update(record.output).digest('hex')===proof.output_hash,'public output hash matches the recorded execution bytes');
const q=quoteFields(Buffer.from(proof.tdx_quote,'base64'));
check(q.report_data===taskHash(proof)+'0'.repeat(64),'TDX REPORTDATA binds the task including output_hash');
const altered={...proof,output_hash:(proof.output_hash[0]==='0'?'1':'0')+proof.output_hash.slice(1)};
check(q.report_data!==taskHash(altered)+'0'.repeat(64),'changing output_hash breaks the signed commitment');
if(args.includes('--fetch')){try{const verdict=await getCollateralAndVerify(Buffer.from(proof.tdx_quote,'base64'),process.env.TRUENAV_PCCS_URL||undefined);check(verdict.status==='UpToDate','Intel quote signature/collateral verification is UpToDate');}catch{check(false,'Intel quote verification unavailable or invalid');}}
else console.log('SKIP Intel collateral refresh in recorded mode; this is protocol replay, not a new attestation');
console.log('This is an existing fingerprint execution, not a live v3 engine run.');process.exitCode=failures?1:0;if(failures)reportNetworkAtExit();
