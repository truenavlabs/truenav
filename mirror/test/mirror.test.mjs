import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import solc from 'solc';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeDeployData, encodeFunctionData, keccak256, sha256, stringToHex, parseEventLogs, serializeTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abi } from '../abi.mjs';
import { broadcast, signedEvent, validateSigned } from '../broadcast.mjs';
import { confirmFinalized, waitForFinality } from '../confirm.mjs';
const vectors=JSON.parse(await readFile(new URL('../fixtures/vectors.json',import.meta.url),'utf8'));
const event=(v=vectors[0])=>({nonce:v.nonce,seq:v.seq,signed_tx:v.signed,tx_hash:v.tx_hash});
const options={mirrorAddress:'0x'+vectors[0].to,mpcAddress:vectors[0].mpc_address};
const fixture=()=>privateKeyToAccount(sha256(stringToHex('TrueNav public disposable mirror signing fixture v1')));

test('event parser requires exactly one typed mirror event and validates every signed field',async()=>{
 const e=event();const log='EVENT_JSON:'+JSON.stringify({standard:'truenav-receipts',version:'1.0.0',event:'mirror_signed',data:[e]});
 assert.deepEqual(signedEvent([log]),e);assert.throws(()=>signedEvent([log,log]));
 const checked=await validateSigned(e,options);assert.equal(checked.args[3],58);
 for(const changed of [{...e,tx_hash:'aa'.repeat(32)},{...e,nonce:1},{...e,seq:2}]) await assert.rejects(validateSigned(changed,options));
 await assert.rejects(validateSigned(e,{...options,mirrorAddress:'0x'+'22'.repeat(20)}));
 await assert.rejects(validateSigned(e,{...options,mpcAddress:'0x'+'22'.repeat(20)}));
});

test('confirmer waits for finalized canonical success and never calls NEAR early or for a reverted tx',async()=>{
 const e=event();let calls=[];let final=9n;
 const client={getChainId:async()=>84532,getTransactionReceipt:async()=>({transactionHash:'0x'+e.tx_hash,status:'success',blockNumber:10n,blockHash:'0xabc'}),getBlock:async(args)=>args.blockTag?{number:final,hash:'0xdef'}:{number:10n,hash:'0xabc'}};
 const near={confirm:async(args)=>calls.push(args)};
 assert.equal(await confirmFinalized(e,{...options,client,near}),false);assert.equal(calls.length,0);
 assert.equal(await waitForFinality(e,{...options,client,near},{attempts:2,delay:async()=>{final=10n;}}),true);
 assert.deepEqual(calls,[{nonce:0,tx_hash:e.tx_hash}]);
 await assert.rejects(confirmFinalized(e,{...options,client:{...client,getTransactionReceipt:async()=>({status:'reverted'})},near}));
 await assert.rejects(confirmFinalized(e,{...options,client:{...client,getBlock:async(args)=>args.blockTag?{number:10n}:{hash:'wrong'}},near}));
 await assert.rejects(confirmFinalized(e,{...options,client:{...client,getChainId:async()=>1},near}));
});

test('Solidity compiles and a local EVM checks only-MPC, increasing per-token seq, events and raw broadcast',async()=>{
 const source=await readFile(new URL('../contracts/TrueNavMirror.sol',import.meta.url),'utf8');
 const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'TrueNavMirror.sol':{content:source}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
 assert.deepEqual((output.errors??[]).filter(e=>e.severity==='error'),[]);
 const artifact=output.contracts['TrueNavMirror.sol'].TrueNavMirror;
 const account=fixture();
 const provider=ganache.provider({chain:{chainId:84532,hardfork:'shanghai'},logging:{quiet:true},wallet:{accounts:[{secretKey:sha256(stringToHex('TrueNav public disposable mirror signing fixture v1')),balance:'0x3635c9adc5dea00000'}]}});
 try {
 const transport=custom(provider);const client=createPublicClient({transport});
 const wallet=createWalletClient({transport,account});
 const deploy=await wallet.sendTransaction({chain:null,data:encodeDeployData({abi:artifact.abi,bytecode:'0x'+artifact.evm.bytecode.object,args:[account.address]}),gas:1500000n});
 const deployed=await client.waitForTransactionReceipt({hash:deploy});assert.equal(deployed.status,'success');const address=deployed.contractAddress;
 const args=[sha256(stringToHex('DEMO-CREDIT')),1n,'0x'+'aa'.repeat(32),58,0,sha256(stringToHex('cashflow-v2.1.0')),1794128400000n];
 const data=encodeFunctionData({abi,functionName:'update',args});
 const tx={type:'eip1559',chainId:84532,nonce:await client.getTransactionCount({address:account.address}),maxFeePerGas:2000000000n,maxPriorityFeePerGas:2000000000n,gas:150000n,to:address,value:0n,data,accessList:[]};
 const raw=await account.signTransaction(tx);const ev={nonce:tx.nonce,seq:1,signed_tx:raw.slice(2),tx_hash:keccak256(raw).slice(2)};
 const hash=await broadcast(ev,{client,mirrorAddress:address,mpcAddress:account.address});
 const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
 const events=parseEventLogs({abi,logs:receipt.logs});assert.equal(events.length,1);assert.equal(events[0].args.seq,1n);assert.equal(events[0].args.tokenIdHash,args[0]);
 let confirmation;
 assert.equal(await confirmFinalized(ev,{client,mirrorAddress:address,mpcAddress:account.address,near:{confirm:async(args)=>{confirmation=args;}}}),true);
 assert.deepEqual(confirmation,{nonce:tx.nonce,tx_hash:ev.tx_hash});
 const latest=await client.readContract({address,abi,functionName:'latest',args:[args[0]]});assert.equal(latest[0],1n);assert.equal(latest[2],58);
 await assert.rejects(client.simulateContract({address,abi,functionName:'update',args,account:account.address}));
 await assert.rejects(client.simulateContract({address,abi,functionName:'update',args:[args[0],2n,...args.slice(2)],account:'0x'+'22'.repeat(20)}));
 await client.simulateContract({address,abi,functionName:'update',args:[sha256(stringToHex('HONEST-CREDIT')),1n,...args.slice(2)],account:account.address});
 await assert.rejects(broadcast(ev,{client:{...client,getChainId:async()=>1},mirrorAddress:address,mpcAddress:account.address}));
 } finally {await provider.disconnect();}
});

test('every committed Rust cross-check vector is independently re-encoded by viem',async()=>{
 for(const v of vectors) {
  const args=[sha256(stringToHex('DEMO-CREDIT')),BigInt(v.seq),'0x'+'aa'.repeat(32),58,0,sha256(stringToHex('cashflow-v2.1.0')),BigInt(Date.parse(v.as_of))];
  const data=encodeFunctionData({abi,functionName:'update',args});
  assert.equal(data.slice(2),v.data);
  const unsigned=serializeTransaction({type:'eip1559',chainId:84532,nonce:v.nonce,maxFeePerGas:BigInt(v.fee),maxPriorityFeePerGas:BigInt(v.fee),gas:150000n,to:'0x'+v.to,value:0n,data,accessList:[]});
  assert.equal(unsigned.slice(2),v.unsigned);assert.equal(keccak256(unsigned).slice(2),v.hash);
  await validateSigned(event(v),{mirrorAddress:'0x'+v.to,mpcAddress:v.mpc_address});
 }
});
