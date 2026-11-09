// CI ONLY: local sandbox state/gas test, with a mocked worker. No live RPC, TEE, deployment or credentials.
// Genesis uses the SDK's public sandbox development identity. It is never printed or copied into git.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Sandbox,GenesisAccount} from 'near-sandbox';
import {Account,JsonRpcProvider,actions,nearToYocto,teraToGas,baseEncode} from 'near-api-js';
const root=new URL('../../',import.meta.url);
const read=p=>JSON.parse(readFileSync(new URL(p,root)));
const receiptId='receipts.tnlab-718ca9.testnet';
const ids={receipts:receiptId,admin:'admin.ci.testnet',pauser:'pauser.ci.testnet',runner:'runner.ci.testnet',outlayer:'outlayer.ci.testnet',worker:'worker.ci.testnet',relayer:'relayer.ci.testnet'};
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
 const oldBytes=execFileSync('git',['show','ecf179c03a658f3c8353687f215dd7006568c096:receipts/dist/truenav_receipts.wasm'],{cwd:root,stdio:['ignore','pipe','ignore'],maxBuffer:4*1024*1024});
 assert.equal(createHash('sha256').update(oldBytes).digest('hex'),'c19fc647d96d13f288d928d6495901c1e542a1e0ff043408c6ec3791a08508f1');
 const v2pin='360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57';
 const config={outlayer:ids.outlayer,project_id:'CI_ONLY',version_key:v2pin,method:'cashflow-v2.1.0',secrets_profile:'CI_ONLY',secrets_owner:receiptId,max_instructions:10000000000,max_memory_mb:128,max_execution_seconds:180,outlayer_deposit:nearToYocto('0.01').toString(),storage_deposit:nearToYocto('0.25').toString(),outlayer_tgas:200,callback_tgas:80};
 await deploy('outlayer',readFileSync(new URL('receipts/mock-outlayer/target/near/mock_outlayer.wasm',root)),'new',{worker:ids.worker});
 await deploy('receipts',oldBytes,'new',{admin:ids.admin,pauser:ids.pauser,config});
 await call('admin','receipts','set_runner',{account:ids.runner,allowed:true},one);
 await call('admin','receipts','register_token',{token_id:'DEMO-CREDIT',kind:'credit'},one);
 async function run(make){
  const signed=await accounts.runner.createSignedTransaction({receiverId:receiptId,actions:[actions.functionCall('request_run',{token_id:'DEMO-CREDIT'},teraToGas('300'),nearToYocto('0.26'))]});
  const hash=baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());await provider.sendTransactionAsync(signed);
  let request;
  for(let i=0;i<100;i++){const rows=await provider.callFunction({contractId:ids.outlayer,method:'get_requests',args:{},blockQuery:{finality:'final'}});if(rows.length){request=rows[0];break}await new Promise(r=>setTimeout(r,200));}
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
 const candidate=readFileSync(new URL('receipts/target/near/truenav_receipts.wasm',root));
 await deploy('receipts',candidate,'migrate_v3',{});
 const after=await view('get_receipt',{token_id:'DEMO-CREDIT',seq:1});assert.equal(after.receipt_version,'2');delete after.receipt_version;assert.deepEqual(after,before);
 assert.equal(await view('get_receipt',{token_id:'DEMO-CREDIT',seq:999}),null);
 const example=read('schema/vectors/engine-v3-derived.json').vectors[0].envelope;
 const context={fund_account:example.fund_account,period_start:example.period_start,period_end:example.period_end,judge_valuation_time:example.valuation_time,source_registry_sha256:'a'.repeat(64),supersedes_seq:null,correction_reason_code:null};
 const configure=async ctx=>call('admin','receipts','configure_v3_fund',{token_id:'DEMO-CREDIT',context:ctx},one);
 await configure(context);await call('admin','receipts','set_attester',{account:ids.relayer},one);await call('admin','receipts','set_config',{config:{...config,method:'truenav-v3.0.1',version_key:example.engine_code_sha256}},one);await call('admin','receipts','unpause',{},one);
 function body(input){const e=structuredClone(example);for(const key of ['receipt_sha256','issued_at','attestation_ref'])delete e[key];for(const key of ['network','receipts_contract','token_id','fund_account','period_start','period_end','seq','prev_receipt_sha256','supersedes_seq','correction_reason_code','request_id','request_nonce','engine_version_key','engine_code_sha256'])e[key]=input.context[key];return e;}
 assert.equal(await run(body),'stored:2');
 const first=await view('get_latest_receipt',{token_id:'DEMO-CREDIT'});assert.equal(first.receipt_version,'3');assert.equal(first.seq,'2');assert.equal(first.prev_receipt_sha256,before.receipt_sha256);assert.equal(await view('get_first_v3_seq',{token_id:'DEMO-CREDIT'}),'2');
 const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
 const {receipt_sha256,...preimage}=first;assert.equal(receipt_sha256,createHash('sha256').update(canonical(preimage)).digest('hex'));
 const binding=await view('get_body_binding',{token_id:'DEMO-CREDIT',seq:'2'});const B=structuredClone(first);for(const k of ['receipt_sha256','attestation_ref','issued_at'])delete B[k];assert.equal(binding.body_sha256,createHash('sha256').update(canonical(B)).digest('hex'));
 const publication={token_id:'DEMO-CREDIT',seq:'2',receipt_sha256:first.receipt_sha256,body_sha256:binding.body_sha256,proof_ref:'https://testnet-api.outlayer.ai/attestations/by-request/1',proof_scheme:'outlayer_tdx_v1'};
 const storedProof=await call('relayer','receipts','publish_attestation',publication,nearToYocto('0.05'));assert.deepEqual(await call('relayer','receipts','publish_attestation',publication,1n),storedProof);assert.deepEqual(await view('get_latest_receipt',{token_id:'DEMO-CREDIT'}),first);assert.equal((await view('get_attestations',{token_id:'DEMO-CREDIT',seq:'2'})).length,1);

 await call('admin','receipts','pause',{},one);await configure({...context,supersedes_seq:'2',correction_reason_code:'coverage_correction'});await call('admin','receipts','unpause',{},one);
 assert.equal(await run(body),'stored:3');const correction=await view('get_latest_receipt',{token_id:'DEMO-CREDIT'});assert.equal(correction.supersedes_seq,'2');assert.equal(correction.prev_receipt_sha256,first.receipt_sha256);
 assert.equal(await run(input=>({...body(input),metrics:{late_share_bps:1500,cohort_principal_cents:850000000}})),'v3_schema');assert.equal((await view('get_latest_receipt',{token_id:'DEMO-CREDIT'})).seq,'3');assert.equal((await view('get_token',{token_id:'DEMO-CREDIT'})).pending,null);
 console.log('PASS CI local sandbox: actual old wasm state retained, v3 callback within 80 Tgas, chain/correction/tags, append-only metadata without quote claims, private-field rejection');
}catch(error){
 console.error('FAIL CI local sandbox v3 migration/callback gate', String(error?.stack ?? error).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g,'ed25519:[redacted]'));process.exitCode=1;
}finally{await sandbox.tearDown();}
