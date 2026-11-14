// CI ONLY: Level 1B rehearsal of the live receipts upgrade (REDEPLOY_PLAN_v2.md). Local near-sandbox, mocked worker.
// No live RPC, TEE, deployment or credentials. Genesis uses the SDK's public sandbox development identity.
//
// What it rehearses, in the corrected live order:
//   exact f32949b3 bytes (git 5a2ea39) with a config shaped like the live account, then
//   [unpaused refusal] -> request a run -> pause -> snapshot -> pending refusal -> drain -> post-pause snapshot ->
//   deploy 5f294c9a + migrate_v3 in ONE batch -> diff against the post-pause snapshot (only the marker may differ) ->
//   negatives -> configure_v3_fund and set_attester while paused -> set_config (0.35 NEAR, 200 and 80 Tgas) ->
//   rollback to f32949b3 -> code-only re-entry with 5f294c9a (no migrate_v3) -> state equal again -> unpause.
//
// The new bytes are the pinned-image build in receipts/target/near (the file the receipts job just built and checked
// against receipts/pinned-builds.json). Both worker account names are the real ones: outlayer.testnet and
// receipts.tnlab-718ca9.testnet.
//
// Fallback if the sandbox refuses a genesis account named outlayer.testnet: run with L1B_SANDBOX_FEATURE=1. The
// candidate is then the sandbox-feature wasm and the worker is outlayer.test.near. That is a weaker check (the bytes are
// not the pinned ones) and the script says so in its output. f32949b3 has no worker allowlist, so it accepts either name.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Sandbox,GenesisAccount} from 'near-sandbox';
import {Account,JsonRpcProvider,actions,nearToYocto,teraToGas,baseEncode} from 'near-api-js';
import {ensureContractWasm} from './ensure-wasm.mjs';
import {containsSandboxAccount} from '../check-sandbox-account.mjs';
const root=new URL('../../',import.meta.url);
const read=p=>JSON.parse(readFileSync(new URL(p,root)));
const sha=b=>createHash('sha256').update(b).digest('hex');
const fallback=process.env.L1B_SANDBOX_FEATURE==='1';
const receiptId='receipts.tnlab-718ca9.testnet';
const ids={receipts:receiptId,admin:'admin.ci.testnet',pauser:'pauser.ci.testnet',runner:'runner.ci.testnet',outlayer:fallback?'outlayer.test.near':'outlayer.testnet',worker:'worker.ci.testnet',relayer:'relayer.ci.testnet'};
const OLD_SHA='f32949b38eef2547d1bbe4441d0d2c5db215846db1a57a95f4f46dbcf7b29c9d';
const OLD_BYTES=266556;
const MARKER_KEY=Buffer.from('truenav:v3:migrated').toString('base64');
const MARKER_VALUE=Buffer.from('3').toString('base64');
// one raw storage record: key bytes + value bytes + 40 bytes of record overhead
const MARKER_STORAGE=Buffer.byteLength('truenav:v3:migrated')+1+40;
const pins=read('receipts/pinned-builds.json');
const build=read('receipts/v3-build.json');
const NEW_SHA=pins.receipts;
const NEW_BYTES=build.receipts.bytes;
const ENGINE_PIN=build.engine.sha256;
assert.equal(NEW_SHA.slice(0,8),'5f294c9a','the pin moved: update REDEPLOY_PLAN_v2.md and this rehearsal together');
assert.equal(ENGINE_PIN.slice(0,8),'098f5d86','the engine pin moved: update REDEPLOY_PLAN_v2.md and this rehearsal together');
// exact old bytes from git history
const oldBytes=execFileSync('git',['show','5a2ea39:receipts/dist/truenav_receipts.wasm'],{cwd:root,stdio:['ignore','pipe','ignore'],maxBuffer:4*1024*1024});
assert.equal(sha(oldBytes),OLD_SHA,'old bytes must be the exact f32949b3 build that is live');
assert.equal(oldBytes.length,OLD_BYTES);
// new bytes
let newBytes;
if(fallback){
 newBytes=readFileSync(ensureContractWasm({crate:'receipts',artifact:'truenav_receipts',sandbox:true}));
 console.log('FALLBACK: sandbox-feature candidate and worker outlayer.test.near. These are NOT the pinned bytes.');
}else{
 newBytes=readFileSync(new URL('receipts/target/near/truenav_receipts.wasm',root));
 assert.equal(sha(newBytes),NEW_SHA,'receipts/target/near/truenav_receipts.wasm is not the pinned 5f294c9a build');
 assert.equal(newBytes.length,NEW_BYTES);
 assert.equal(containsSandboxAccount(newBytes),false,'the pinned bytes must not carry the sandbox worker account');
}
const newSha=sha(newBytes);
const liveShape={outlayer:ids.outlayer,project_id:'receipts.tnlab-718ca9.testnet/truenav-engine',version_key:'360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57',method:'cashflow-v2.1.0',secrets_profile:'engine',secrets_owner:receiptId,max_instructions:10000000000,max_memory_mb:128,max_execution_seconds:30,outlayer_deposit:nearToYocto('0.01').toString(),storage_deposit:nearToYocto('0.25').toString(),outlayer_tgas:230,callback_tgas:50};
const v3Config={...liveShape,method:'truenav-v3.0.1',version_key:ENGINE_PIN,storage_deposit:nearToYocto('0.35').toString(),outlayer_tgas:200,callback_tgas:80};
const genesis=Object.values(ids).map(id=>GenesisAccount.createDefault(id));
const sandbox=await Sandbox.start({config:{additionalAccounts:genesis}});
try{
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(sandbox.rpcUrl).hostname),'CI must remain local');
 const provider=new JsonRpcProvider({url:sandbox.rpcUrl});
 const accounts=Object.fromEntries(Object.entries(ids).map(([name,id])=>[name,new Account(id,provider,genesis.find(g=>g.accountId===id).privateKey)]));
 const one=1n;
 const rpc=async(method,params)=>{const r=await fetch(sandbox.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw new Error(method+' '+JSON.stringify(j.error));return j.result;};
 const query=params=>rpc('query',{finality:'final',account_id:receiptId,...params});
 const view=(method,args={})=>provider.callFunction({contractId:receiptId,method,args,blockQuery:{finality:'final'}});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const send=(who,receiver,acts)=>accounts[who].signAndSendTransaction({receiverId:receiver,actions:acts,throwOnFailure:false,waitUntil:'FINAL'});
 const ok=tx=>Boolean(tx.status&&Object.hasOwn(tx.status,'SuccessValue'));
 const must=async(label,tx)=>{tx=await tx;assert.ok(ok(tx),label+' failed: '+JSON.stringify(tx.status));assert.ok(tx.receipts_outcome.every(r=>!r.outcome.status.Failure),label+' has a failed receipt');return tx;};
 const refused=async(label,tx,pattern)=>{tx=await tx;assert.ok(!ok(tx),label+' must be refused');assert.match(JSON.stringify(tx.status),pattern,label+' refused for another reason: '+JSON.stringify(tx.status));console.log('refused as expected:',label);return tx;};
 const call=(who,method,args={},deposit=one,gas='100')=>send(who,receiptId,[actions.functionCall(method,args,teraToGas(gas),deposit)]);
 const gasOf=tx=>tx.receipts_outcome.reduce((n,r)=>n+BigInt(r.outcome.gas_burnt),0n)+BigInt(tx.transaction_outcome.outcome.gas_burnt);
 const codeSha=async()=>sha(Buffer.from((await query({request_type:'view_code'})).code_base64,'base64'));
 async function snap(label){
  const acct=await query({request_type:'view_account'});
  const st=await query({request_type:'view_state',prefix_base64:''});
  const state=Object.fromEntries(st.values.map(v=>[v.key,v.value]));
  const config=await view('get_config');
  const tokens=[];for(let from=0;;from+=100){const page=await view('list_tokens',{from,limit:100});tokens.push(...page);if(page.length<100)break;}
  const detail={};for(const t of tokens)detail[t.token_id]=await view('get_token',{token_id:t.token_id});
  const s={label,codeSha:await codeSha(),codeHash:acct.code_hash,storage:acct.storage_usage,state,config,tokens,detail};
  console.log('snapshot',label,JSON.stringify({code:s.codeSha.slice(0,8),storage:s.storage,stateKeys:Object.keys(state).length,tokens:tokens.length}));
  return s;
 }
 const pendingOf=async s=>Object.entries(s.detail).filter(([,d])=>d.pending).map(([t])=>t);
 // ---- setup: the worker, then f32949b3 with a live-shaped config -------------------------------------------------
 await must('mock worker',send('outlayer',ids.outlayer,[actions.deployContract(readFileSync(ensureContractWasm({crate:'receipts/mock-outlayer',artifact:'mock_outlayer'}))),actions.functionCall('new',{worker:ids.worker},teraToGas('100'),0n)]));
 await must('deploy f32949b3',send('receipts',receiptId,[actions.deployContract(oldBytes),actions.functionCall('new',{admin:ids.admin,pauser:ids.pauser,config:liveShape},teraToGas('100'),0n)]));
 assert.equal(await codeSha(),OLD_SHA);
 await must('set_runner',call('admin','set_runner',{account:ids.runner,allowed:true}));
 for(const [id,kind] of [['DEMO-CREDIT','credit'],['DEMO-RENTAL','rental'],['HONEST-CREDIT','credit'],['HONEST-RENTAL','rental']])await must('register '+id,call('admin','register_token',{token_id:id,kind}));
 assert.equal((await view('get_config')).config.outlayer,ids.outlayer);
 // ---- refusal 1: the batch on an unpaused account is refused and the old code stays ------------------------------
 const batch=()=>send('receipts',receiptId,[actions.deployContract(newBytes),actions.functionCall('migrate_v3',{},teraToGas('100'),0n)]);
 await refused('deploy plus migrate_v3 while unpaused',batch(),/pause before migration/);
 assert.equal(await codeSha(),OLD_SHA,'a refused batch must leave the old code deployed');
 // ---- a run in flight, like a runner that started before the pause -----------------------------------------------
 const signed=await accounts.runner.createSignedTransaction({receiverId:receiptId,actions:[actions.functionCall('request_run',{token_id:'HONEST-CREDIT'},teraToGas('300'),nearToYocto('0.26'))]});
 const runHash=baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
 await provider.sendTransactionAsync(signed);
 let request;
 for(let i=0;i<100&&!request;i++){const rows=await provider.callFunction({contractId:ids.outlayer,method:'get_requests',args:{},blockQuery:{finality:'final'}});if(rows.length)request=rows[0];else await sleep(200);}
 assert.ok(request,'the mock worker must receive the request');
 // ---- pause, then the pending check over every token -------------------------------------------------------------
 await must('pause',call('pauser','pause'));
 assert.equal((await view('get_config')).paused,true);
 let s1=await snap('H0 after pause, run in flight');
 assert.deepEqual(await pendingOf(s1),['HONEST-CREDIT'],'exactly the in-flight token is pending');
 await refused('deploy plus migrate_v3 with a pending run',batch(),/drain pending runs before migration/);
 assert.equal(await codeSha(),OLD_SHA);
 // ---- drain: the worker reports a failed run, which the callback stores as outlayer_run_failed, as live HONEST-CREDIT did ---
 await must('worker resolve',send('worker',ids.outlayer,[actions.functionCall('resolve',{request_id:request.request_id,success:false,output:''},teraToGas('200'),0n)]));
 const runTx=await provider.viewTransactionStatusWithReceipts({txHash:runHash,accountId:ids.runner,waitUntil:'FINAL'});
 assert.ok(runTx.receipts_outcome.every(r=>!r.outcome.status.Failure),'the old-code callback must fit the live 50 Tgas budget');
 // ---- post-pause snapshot: the baseline for everything after ------------------------------------------------------
 const h1=await snap('H1 post-pause baseline');
 assert.equal(h1.codeSha,OLD_SHA);
 assert.equal(h1.config.paused,true);
 assert.deepEqual(await pendingOf(h1),[],'every token must be idle before the batch');
 assert.equal(h1.tokens.length,4);
 assert.equal(h1.detail['HONEST-CREDIT'].last_failure.code,'outlayer_run_failed');
 for(const t of h1.tokens)assert.equal(t.receipts,0,'live has no receipts, so the rehearsal has none');
 for(const key of Object.keys(h1.state)){const raw=Buffer.from(key,'base64').toString('latin1');assert.ok(!/^(mirror:v1:|late:|truenav:v3:)/.test(raw),'no mirror, late or v3 keys may exist before the batch: '+raw);}
 // ---- the batch: deploy 5f294c9a and migrate_v3 in one transaction -----------------------------------------------
 const mig=await must('deploy plus migrate_v3',batch());
 console.log('batch gas burnt (Tgas):',Number(gasOf(mig)/1_000_000_000n)/1000,'prepaid for migrate_v3: 100');
 console.log('batch receipts:',JSON.stringify(mig.receipts_outcome.map(r=>({executor:r.outcome.executor_id,gas_burnt:r.outcome.gas_burnt,status:Object.keys(r.outcome.status)[0]}))));
 const h2=await snap('H2 after migrate');
 assert.equal(h2.codeSha,newSha,'the deployed code is the new bytes');
 assert.notEqual(h2.codeHash,h1.codeHash);
 assert.deepEqual(Object.keys(h2.state).filter(k=>!(k in h1.state)),[MARKER_KEY],'exactly one new key');
 assert.equal(h2.state[MARKER_KEY],MARKER_VALUE);
 for(const [k,v] of Object.entries(h1.state))assert.equal(h2.state[k],v,'old key changed by migrate: '+Buffer.from(k,'base64').toString('latin1'));
 assert.equal(h2.state[Buffer.from('STATE').toString('base64')],h1.state[Buffer.from('STATE').toString('base64')],'the root must be byte-identical');
 assert.deepEqual(h2.config,h1.config,'get_config must be identical, paused included');
 assert.deepEqual(h2.tokens,h1.tokens);
 assert.deepEqual(h2.detail,h1.detail);
 assert.equal(await view('get_receipt',{token_id:'DEMO-CREDIT',seq:999}),null);
 assert.equal(BigInt(h2.storage),BigInt(h1.storage)-BigInt(OLD_BYTES)+BigInt(newBytes.length)+BigInt(MARKER_STORAGE),'storage_usage must grow by the code delta plus the marker');
 // ---- negatives right after the migration (still paused) -----------------------------------------------------------
 await refused('second migrate_v3',call('receipts','migrate_v3',{},0n),/already migrated/);
 const runner=()=>send('runner',receiptId,[actions.functionCall('request_run',{token_id:'DEMO-CREDIT'},teraToGas('300'),nearToYocto('0.26'))]);
 await refused('request_run while paused',runner(),/paused/);
 await must('unpause for the v2 write check',call('pauser','unpause'));
 await refused('request_run on the migrated account before set_config',runner(),/v3 migration forbids v2 writes/);
 await must('re-pause',call('pauser','pause'));
 assert.equal((await view('get_config')).paused,true);
 // ---- configuration, all while paused ---------------------------------------------------------------------------
 const example=read('schema/vectors/engine-v3-derived.json').vectors[0].envelope;
 const ctx=(fund)=>({fund_account:fund,period_start:example.period_start,period_end:example.period_end,judge_valuation_time:example.valuation_time,source_registry_sha256:'a'.repeat(64),supersedes_seq:null,correction_reason_code:null});
 await refused('configure_v3_fund on a rental token',call('admin','configure_v3_fund',{token_id:'DEMO-RENTAL',context:ctx(example.fund_account)}),/v3 accepts credit only/);
 for(const t of ['DEMO-CREDIT','HONEST-CREDIT'])await must('configure_v3_fund '+t,call('admin','configure_v3_fund',{token_id:t,context:ctx(example.fund_account)}));
 await refused('configure_v3_fund with another fund account',call('admin','configure_v3_fund',{token_id:'DEMO-CREDIT',context:ctx('other.sim.testnet')}),/fund binding immutable/);
 await must('set_attester',call('admin','set_attester',{account:ids.relayer}));
 assert.equal(await view('get_attester'),ids.relayer);
 await refused('set_config with 0.25 NEAR storage on the v3 method',call('admin','set_config',{config:{...v3Config,storage_deposit:nearToYocto('0.25').toString()}}),/storage_deposit too low/);
 await refused('set_config back to the v2 method',call('admin','set_config',{config:liveShape}),/v3 migration forbids v2 writes/);
 await refused('set_config with another worker account',call('admin','set_config',{config:{...v3Config,outlayer:ids.worker}}),/outlayer account is fixed at init/);
 await must('set_config v3 (0.35 NEAR, 200 and 80 Tgas)',call('admin','set_config',{config:v3Config}));
 const cfg=(await view('get_config'));
 assert.equal(cfg.paused,true);
 assert.deepEqual({m:cfg.config.method,k:cfg.config.version_key,s:cfg.config.storage_deposit,o:cfg.config.outlayer_tgas,c:cfg.config.callback_tgas,w:cfg.config.outlayer},{m:'truenav-v3.0.1',k:ENGINE_PIN,s:nearToYocto('0.35').toString(),o:200,c:80,w:ids.outlayer});
 for(const t of ['DEMO-CREDIT','HONEST-CREDIT'])assert.deepEqual(await view('get_run_input',{token_id:t}),{receipt_version:'3',status:'no_pending_request'});
 const funds=await view('list_funds');
 assert.deepEqual(funds.map(f=>f.token_id).sort(),['DEMO-CREDIT','HONEST-CREDIT']);
 const h3=await snap('H3 configured, paused');
 // ---- rollback: old code stays safe over the v3 state; the marker survives ---------------------------------------
 await must('rollback: deploy f32949b3 only',send('receipts',receiptId,[actions.deployContract(oldBytes)]));
 const r1=await snap('R1 rolled back');
 assert.equal(r1.codeSha,OLD_SHA);
 assert.deepEqual(r1.state,h3.state,'a code-only deploy must not touch state');
 assert.equal(r1.state[MARKER_KEY],MARKER_VALUE,'the marker remains after rollback');
 await must('rollback: old set_config back to the v2 config',call('admin','set_config',{config:liveShape}));
 const r2=await snap('R2 old code, v2 config');
 assert.equal(r2.config.config.method,'cashflow-v2.1.0');
 assert.equal(r2.state[MARKER_KEY],MARKER_VALUE,'the marker still remains');
 assert.deepEqual(r2.tokens,h1.tokens);
 // ---- re-entry: code only, never migrate_v3 --------------------------------------------------------------------------
 await must('re-entry: deploy 5f294c9a only, no migrate_v3',send('receipts',receiptId,[actions.deployContract(newBytes)]));
 const e1=await snap('E1 re-entered');
 assert.equal(e1.codeSha,newSha);
 assert.deepEqual(e1.state,r2.state,'re-entry must not touch state');
 await refused('migrate_v3 after re-entry',call('receipts','migrate_v3',{},0n),/already migrated/);
 await refused('v2 config on the re-entered code',call('admin','set_config',{config:liveShape}),/v3 migration forbids v2 writes/);
 await must('re-entry: set_config v3 again',call('admin','set_config',{config:v3Config}));
 const e2=await snap('E2 re-entered and configured');
 assert.deepEqual(e2.state,h3.state,'after re-entry and set_config the whole state equals the pre-rollback state');
 assert.deepEqual(e2.config,h3.config);
 assert.deepEqual(e2.detail,h3.detail);
 assert.equal(e2.storage,h3.storage);
 assert.deepEqual(await view('list_funds'),funds);
 assert.equal(await view('get_attester'),ids.relayer);
 // ---- unpause, and the pause gates hold --------------------------------------------------------------------------
 await must('unpause',call('pauser','unpause'));
 assert.equal((await view('get_config')).paused,false);
 await refused('configure_v3_fund while unpaused',call('admin','configure_v3_fund',{token_id:'DEMO-CREDIT',context:ctx(example.fund_account)}),/pause before changing run context/);
 await refused('set_attester while unpaused',call('admin','set_attester',{account:ids.relayer}),/pause before writer rotation/);
 for(const t of ['DEMO-CREDIT','HONEST-CREDIT'])assert.deepEqual(await view('get_run_input',{token_id:t}),{receipt_version:'3',status:'no_pending_request'});
 console.log(`PASS Level 1B: ${fallback?'FALLBACK sandbox-feature candidate':'pinned '+newSha.slice(0,8)+' bytes'} migrated from exact f32949b3 bytes; state diff after the pause is the marker only; refusals, rollback and code-only re-entry hold`);
}catch(error){
 console.error('FAIL Level 1B rehearsal', String(error?.stack ?? error).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g,'ed25519:[redacted]'));process.exitCode=1;
}finally{await sandbox.tearDown();}
