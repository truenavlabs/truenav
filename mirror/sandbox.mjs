// Local sandbox only, mocked MPC and mocked OutLayer. No live accounts, credentials or network transactions.
// Build receipts, receipts/mock-outlayer and mirror/mock-signer with the pinned image before running this.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sandbox, GenesisAccount, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from 'near-api-js';
import { validateSigned } from './broadcast.mjs';
const root = new URL('../',import.meta.url);
const wasm=(path)=>new Uint8Array(readFileSync(new URL(path,root)));
const sandbox=await Sandbox.start({config:{additionalAccounts:[GenesisAccount.createDefault('v1.signer-prod.testnet')]}});
try {
 const provider=new JsonRpcProvider({url:sandbox.rpcUrl});
 const owner=new Account(DEFAULT_ACCOUNT_ID,provider,DEFAULT_PRIVATE_KEY);
 const accounts={};
 for(const name of ['receipts','outlayer','worker']) {
  const key=KeyPair.fromRandom('ed25519');const id=`${name}.${DEFAULT_ACCOUNT_ID}`;
  await owner.signAndSendTransaction({receiverId:id,actions:[actions.createAccount(),actions.transfer(nearToYocto('30')),actions.addFullAccessKey(key.getPublicKey())],waitUntil:'FINAL'});
  accounts[name]=new Account(id,provider,key.toString());
 }
 const id=(name)=>accounts[name].accountId;
 const call=(who,contract,method,args,deposit=0n,gas=100000000000000n)=>who.signAndSendTransaction({receiverId:contract,actions:[actions.functionCall(method,args,gas,deposit)],waitUntil:'FINAL'});
 const view=(method,args={})=>provider.callFunction({contractId:id('receipts'),method,args,blockQuery:{finality:'final'}});
 const config={outlayer:id('outlayer'),project_id:`${id('receipts')}/truenav-engine`,version_key:'36'.repeat(32),method:'cashflow-v2.1.0',secrets_profile:'engine',secrets_owner:id('receipts'),max_instructions:10000000000,max_memory_mb:128,max_execution_seconds:30,outlayer_deposit:nearToYocto('0.01').toString(),storage_deposit:nearToYocto('0.25').toString(),outlayer_tgas:230,callback_tgas:50};
 await accounts.receipts.signAndSendTransaction({receiverId:id('receipts'),actions:[actions.deployContract(wasm('receipts/target/near/truenav_receipts.wasm')),actions.functionCall('new',{admin:DEFAULT_ACCOUNT_ID,pauser:DEFAULT_ACCOUNT_ID,config},50000000000000n,0n)],waitUntil:'FINAL'});
 await accounts.outlayer.signAndSendTransaction({receiverId:id('outlayer'),actions:[actions.deployContract(wasm('receipts/mock-outlayer/target/near/mock_outlayer.wasm')),actions.functionCall('new',{worker:id('worker')},50000000000000n,0n)],waitUntil:'FINAL'});
 // Give the fixed production signer account a public disposable key only in this local genesis.
 const signer=new Account('v1.signer-prod.testnet',provider,DEFAULT_PRIVATE_KEY);
 await signer.signAndSendTransaction({receiverId:'v1.signer-prod.testnet',actions:[actions.deployContract(wasm('mirror/mock-signer/target/near/truenav_mock_signer.wasm'))],waitUntil:'FINAL'});
 await call(owner,id('receipts'),'set_runner',{account:DEFAULT_ACCOUNT_ID,allowed:true},1n);
 await call(owner,id('receipts'),'register_token',{token_id:'DEMO-CREDIT',kind:'credit'},1n);
 const pending=call(owner,id('receipts'),'request_run',{token_id:'DEMO-CREDIT'},nearToYocto('0.26'),300000000000000n);
 let open;
 for(let i=0;i<60;i++) { const requests=await provider.callFunction({contractId:id('outlayer'),method:'get_requests',args:{},blockQuery:{finality:'final'}});if(requests.length){open=requests[0];break;}await new Promise(r=>setTimeout(r,500)); }
 assert.ok(open,'mock execution requested');
 const fixtures=JSON.parse(readFileSync(new URL('receipts/tests/fixtures/engine-receipts.json',root)));
 const receipt=JSON.parse(fixtures.receipts['DEMO-CREDIT'].output);receipt.run_nonce=JSON.parse(open.input_data).run_nonce;
 await call(accounts.worker,id('outlayer'),'resolve',{request_id:open.request_id,success:true,output:JSON.stringify(receipt)});
 await pending;
 const stored=await view('get_latest',{token_id:'DEMO-CREDIT'});assert.equal(stored.seq,1);
 const vector=JSON.parse(readFileSync(new URL('mirror/fixtures/vectors.json',root)))[0];
 await call(owner,id('receipts'),'set_mirror_config',{config:{chain_id:84532,mirror_address:vector.to,fee_cap:100000000000,public_key:vector.public_key}},1n);
 await assert.rejects(call(accounts.worker,id('receipts'),'on_mirror_signed',{nonce:0,attempt:0}));
 await call(owner,id('receipts'),'request_mirror',{token_id:'DEMO-CREDIT',seq:1,fee:1000000000},1n,200000000000000n);
 let request=await view('get_mirror_request',{nonce:0});assert.ok(request.attempts[0].signed_tx,'private callback stores signature');
 const {keccak256}=await import('viem');
 const event={nonce:0,seq:1,signed_tx:request.attempts[0].signed_tx,tx_hash:keccak256('0x'+request.attempts[0].signed_tx).slice(2)};
 await validateSigned(event,{mirrorAddress:'0x'+vector.to,mpcAddress:vector.mpc_address});
 await assert.rejects(call(owner,id('receipts'),'request_mirror',{token_id:'DEMO-CREDIT',seq:1,fee:1000000000},1n));
 await call(owner,id('receipts'),'resign_mirror',{nonce:0,fee:1200000000},1n,200000000000000n);
 request=await view('get_mirror_request',{nonce:0});assert.equal(request.attempts.length,2);assert.ok(request.attempts[1].signed_tx);
 await assert.rejects(call(owner,id('receipts'),'confirm_mirror',{nonce:0,tx_hash:'aa'.repeat(32)},1n));
 // An earlier signed replacement may be the one that lands.
 await call(owner,id('receipts'),'confirm_mirror',{nonce:0,tx_hash:event.tx_hash},1n);
 assert.equal((await view('get_mirror_config')).next_nonce,1);
 console.log('PASS local sandbox: stored receipt, mock MPC callback, private access, nonce serialization, fee replacement, exact-hash confirmation');
} finally {await sandbox.stop();}
