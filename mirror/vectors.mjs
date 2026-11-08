// Public deterministic test fixture only. No deployed or operator credential is used.
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, serializeTransaction, keccak256, sha256, stringToHex, parseSignature } from 'viem';
import { writeFile } from 'node:fs/promises';
import { abi } from './abi.mjs';
const account = privateKeyToAccount(sha256(stringToHex('TrueNav public disposable mirror signing fixture v1')));
const to = '0x1111111111111111111111111111111111111111';
const out=[];
for(const [nonce,fee,seq,as_of] of [[0,1000000000,1,'2026-11-08T09:00:00Z'],[127,1100000000,2,'2026-11-08T09:00:00.123Z'],[128,2000000000,256,'2000-02-29T00:00:00Z'],[0,1200000000,1,'2026-11-08T09:00:00Z']]) {
 const args=[sha256(stringToHex('DEMO-CREDIT')),BigInt(seq),'0x'+'aa'.repeat(32),58,0,sha256(stringToHex('cashflow-v2.1.0')),BigInt(Date.parse(as_of))];
 const data=encodeFunctionData({abi,functionName:'update',args});
 const tx={type:'eip1559',chainId:84532,nonce,maxFeePerGas:BigInt(fee),maxPriorityFeePerGas:BigInt(fee),gas:150000n,to,value:0n,data,accessList:[]};
 const unsigned=serializeTransaction(tx); const hash=keccak256(unsigned); const sig=parseSignature(await account.sign({hash}));
 const signed=serializeTransaction(tx,sig);
 const compressedR=((sig.yParity ?? Number(sig.v-27n))===0?'02':'03')+sig.r.slice(2);
 out.push({nonce,fee,seq,as_of,to:to.slice(2),data:data.slice(2),unsigned:unsigned.slice(2),hash:hash.slice(2),signed:signed.slice(2),tx_hash:keccak256(signed).slice(2),public_key:account.publicKey.slice(4),mpc_address:account.address,
  response:{scheme:'Secp256k1',big_r:{affine_point:compressedR},s:{scalar:sig.s.slice(2)},recovery_id:sig.yParity}});
}
await writeFile(new URL('./fixtures/vectors.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
