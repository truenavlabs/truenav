// CI ONLY: local sandbox state/gas test, with a mocked worker. No live RPC, TEE, deployment or credentials.
// Genesis uses the SDK's public sandbox development identity. It is never printed or copied into git.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Sandbox,GenesisAccount} from 'near-sandbox';
import {Account,JsonRpcProvider,actions,nearToYocto,teraToGas,baseEncode} from 'near-api-js';
import {ensureContractWasm} from './ensure-wasm.mjs';
const root=new URL('../../',import.meta.url);
const read=p=>JSON.parse(readFileSync(new URL(p,root)));
const receiptId='receipts.tnlab-718ca9.testnet';
const ids={receipts:receiptId,admin:'admin.ci.testnet',pauser:'pauser.ci.testnet',runner:'runner.ci.testnet',outlayer:'outlayer.test.near',worker:'worker.ci.testnet',relayer:'relayer.ci.testnet'};
const genesis=Object.values(ids).map(id=>GenesisAccount.createDefault(id));
const sandbox=await Sandbox.start({config:{additionalAccounts:genesis}});
try{
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(sandbox.rpcUrl).hostname),'CI must remain local');
 const provider=new JsonRpcProvider({url:sandbox.rpcUrl});
 const accounts=Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,new Account(id,provider,genesis.find(g=>g.accountId===id).privateKey)]));
 const one=1n;
 const decode=tx=>{assert.ok(tx.status&&Object.hasOwn(tx.status,'SuccessValue'),'local sandbox transaction failed: '+JSON.stringify(tx.status));return tx.status.SuccessValue?JSON.parse(Buffer.from(tx.status.SuccessValue,'base64').toString()):null;};
 const call=async(who,contract,method,args={},deposit=0n,gas='100')=>decode(await accounts[who].signAndSendTransaction({receiverId:ids[contract],actions:[actions.functionCall(method,args,teraToGas(gas),deposit)],throwOnFailure:false,waitUntil:'FINAL'}));
 const view=(method,args={})=>provider.callFunction({contractId:receiptId,method,args,blockQuery:{finality:'final'}});
 const deploy=async(name,bytes,method,args)=>decode(await accounts[name].signAndSendTransaction({receiverId:ids[name],actions:[actions.deployContract(bytes),actions.functionCall(method,args,teraToGas('100'),0n)],waitUntil:'FINAL'}));
 const oldBytes=execFileSync('git',['show','615a82be3536d9f8300e75ef085008b13ccd23bb:receipts/dist/truenav_receipts.wasm'],{cwd:root,stdio:['ignore','pipe','ignore'],maxBuffer:4*1024*1024});
 assert.equal(createHash('sha256').update(oldBytes).digest('hex'),'c19fc647d96d13f288d928d6495901c1e542a1e0ff043408c6ec3791a08508f1');
 const v2pin='360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57';
 const config={outlayer:ids.outlayer,project_id:'CI_ONLY',version_key:v2pin,method:'cashflow-v2.1.0',secrets_profile:'CI_ONLY',secrets_owner:receiptId,max_instructions:10000000000,max_memory_mb:128,max_execution_seconds:180,outlayer_deposit:nearToYocto('0.01').toString(),storage_deposit:nearToYocto('0.35').toString(),outlayer_tgas:200,callback_tgas:80};
 await deploy('outlayer',readFileSync(ensureContractWasm({crate:'receipts/mock-outlayer',artifact:'mock_outlayer'})),'new',{worker:ids.worker});
 await deploy('receipts',oldBytes,'new',{admin:ids.admin,pauser:ids.pauser,config});
 await call('admin','receipts','set_runner',{account:ids.runner,allowed:true},one);
 await call('admin','receipts','register_token',{token_id:'DEMO-CREDIT',kind:'credit'},one);
 async function run(make){
  const signed=await accounts.runner.createSignedTransaction({receiverId:receiptId,actions:[actions.functionCall('request_run',{token_id:'DEMO-CREDIT'},teraToGas('300'),nearToYocto('0.36'))]});
  const hash=baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());await provider.sendTransactionAsync(signed);
  let request;
  for(let i=0;i<100;i++){const rows=await provider.callFunction({contractId:ids.outlayer,method:'get_requests',args:{},blockQuery:{finality:'final'}});if(rows.length){request=rows[0];break}await new Promise(r=>setTimeout(r,200));}
  if(!request){
   try {
    const failed=await provider.viewTransactionStatusWithReceipts({txHash:hash,accountId:ids.runner,waitUntil:'NONE'});
    console.error('CI admission timeout',JSON.stringify({status:failed.status,receipts:failed.receipts_outcome.map(r=>({executor:r.outcome.executor_id,gas_burnt:r.outcome.gas_burnt,status:r.outcome.status}))}));
   } catch(error) {console.error('CI admission status lookup failed',String(error?.message??error).replace(/ed25519:[A-Za-z0-9]+/g,'[REDACTED]'));}
  }
  assert.ok(request,'local mock worker request must arrive');const input=JSON.parse(request.input_data);
  await call('worker','outlayer','resolve',{request_id:request.request_id,success:true,output:JSON.stringify(make(input))},0n,'200');
  const outcome=await provider.viewTransactionStatusWithReceipts({txHash:hash,accountId:ids.runner,waitUntil:'FINAL'});
  console.log('CI receipt gas and status',JSON.stringify(outcome.receipts_outcome.map(r=>({executor:r.outcome.executor_id,gas_burnt:r.outcome.gas_burnt,status:r.outcome.status}))), 'callback budget Tgas',config.callback_tgas);
  assert.ok(outcome.receipts_outcome.every(r=>!r.outcome.status.Failure),'callback must fit its configured wasm gas budget');return decode(outcome);
 }
 const v2=JSON.parse(read('receipts/tests/fixtures/engine-receipts.json').receipts['DEMO-CREDIT'].output);
 assert.equal(await run(input=>({...v2,run_nonce:input.run_nonce})),'stored:1');
 const before=await view('get_receipt',{token_id:'DEMO-CREDIT',seq:1});
 await call('admin','receipts','pause',{},one);
 const candidate=readFileSync(ensureContractWasm({crate:'receipts',artifact:'truenav_receipts',sandbox:true}));
 await deploy('receipts',candidate,'migrate_v3',{});
 const after=await view('get_receipt',{token_id:'DEMO-CREDIT',seq:1});
 assert.equal(after.receipt_version,'2');
 for (const key of ['token_id','seq','score','band','method','version_key','receipt_sha256','period','as_of']) assert.equal(after[key], before[key], key);
 assert.equal(after.receipt.includes('outstanding_cents'), false, 'the public v2 view must stay redacted after migrate');
 assert.equal(await view('get_receipt',{token_id:'DEMO-CREDIT',seq:999}),null);
 const example=read('schema/vectors/engine-v3-derived.json').vectors[0].envelope;
 const context={fund_account:example.fund_account,period_start:example.period_start,period_end:example.period_end,judge_valuation_time:example.valuation_time,source_registry_sha256:'a'.repeat(64),supersedes_seq:null,correction_reason_code:null};
 const configure=async ctx=>call('admin','receipts','configure_v3_fund',{token_id:'DEMO-CREDIT',context:ctx},one);
 await configure(context);await call('admin','receipts','set_attester',{account:ids.relayer},one);await call('admin','receipts','set_config',{config:{...config,method:'truenav-v3.0.1',version_key:example.engine_code_sha256}},one);await call('admin','receipts','unpause',{},one);
 function body(input){const e=structuredClone(example);for(const key of ['receipt_sha256','issued_at','attestation_ref'])delete e[key];for(const key of ['network','receipts_contract','token_id','fund_id','fund_account','period_start','period_end','seq','prev_receipt_sha256','supersedes_seq','correction_reason_code','request_id','request_nonce','engine_version_key','engine_code_sha256'])e[key]=input.context[key];return e;}
 assert.equal(await run(body),'stored:2');
 const first=await view('get_latest_receipt',{token_id:'DEMO-CREDIT'});assert.equal(first.receipt_version,'3');assert.equal(first.seq,'2');assert.equal(first.prev_receipt_sha256,before.receipt_sha256);assert.equal(await view('get_first_v3_seq',{token_id:'DEMO-CREDIT'}),'2');
 const latest=await view('get_latest',{token_id:'DEMO-CREDIT'});
 assert.equal(latest.receipt_sha256,createHash('sha256').update(latest.receipt).digest('hex'));
 assert.equal(first.private_commitment,undefined,'the frozen v3.0.1 body carries no private_commitment');
 const binding=await view('get_body_binding',{token_id:'DEMO-CREDIT',seq:'2'});
 assert.equal(binding.receipt_sha256,first.receipt_sha256);
 assert.match(binding.body_sha256,/^[0-9a-f]{64}$/);
 const publication={token_id:'DEMO-CREDIT',seq:'2',receipt_sha256:first.receipt_sha256,body_sha256:binding.body_sha256,proof_ref:'https://testnet-api.outlayer.ai/attestations/by-request/1',proof_scheme:'outlayer_tdx_v1'};
 const storedProof=await call('relayer','receipts','publish_attestation',publication,nearToYocto('0.05'));assert.deepEqual(await call('relayer','receipts','publish_attestation',publication,1n),storedProof);assert.deepEqual(await view('get_latest_receipt',{token_id:'DEMO-CREDIT'}),first);assert.equal((await view('get_attestations',{token_id:'DEMO-CREDIT',seq:'2'})).length,1);

 const seq2hash=(await view('get_latest',{token_id:'DEMO-CREDIT'})).receipt_sha256;
 await call('admin','receipts','pause',{},one);await configure({...context,supersedes_seq:'2',correction_reason_code:'coverage_correction'});await call('admin','receipts','unpause',{},one);
 assert.equal(await run(body),'stored:3');const correction=await view('get_latest_receipt',{token_id:'DEMO-CREDIT'});assert.equal(correction.supersedes_seq,'2');assert.equal(correction.prev_receipt_sha256,first.receipt_sha256);assert.notEqual(correction.prev_receipt_sha256,seq2hash,'fix 14: the chain links the envelope hash, not the wrapper public-body hash');
 assert.equal(await run(input=>({...body(input),not_a_public_field:true})),'v3_schema');const rejected=await view('get_latest_receipt',{token_id:'DEMO-CREDIT'});assert.equal(rejected.head_status,'failed');assert.notEqual(rejected.score,99);assert.equal((await view('get_token',{token_id:'DEMO-CREDIT'})).pending,null);
 console.log('PASS CI local sandbox: actual old wasm state retained, v3 callback within 80 Tgas, chain/correction/tags, append-only metadata without quote claims, private-field rejection');
}catch(error){
 console.error('FAIL CI local sandbox v3 migration/callback gate', String(error?.stack ?? error).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g,'ed25519:[redacted]'));process.exitCode=1;
}finally{await sandbox.tearDown();}
