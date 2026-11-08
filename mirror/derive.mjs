// Public testnet views only. The derived public key is configuration, never a signing credential.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { keccak256 } from 'viem';
import { pathToFileURL } from 'node:url';
import { PATH } from './abi.mjs';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode(s) {
 let n=0n;for(const c of s){const i=alphabet.indexOf(c);if(i<0)throw Error('invalid public key');n=n*58n+BigInt(i);}
 const hex=n.toString(16).padStart(128,'0');return Uint8Array.from(Buffer.from(hex,'hex'));
}
export function derive(root, predecessor) {
 if (!predecessor.endsWith('.testnet') || !root.startsWith('secp256k1:')) throw Error('testnet ECDSA required');
 const bytes=decode(root.slice(10));if(bytes.length!==64)throw Error('invalid public key');
 const tweak=BigInt('0x'+Buffer.from(sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${PATH}`))).toString('hex'))%secp256k1.Point.Fn.ORDER;
 const point=secp256k1.Point.fromBytes(Buffer.concat([Buffer.from([4]),Buffer.from(bytes)]));
 const child=(tweak===0n?point:point.add(secp256k1.Point.BASE.multiply(tweak))).toBytes(false);
 const public_key=Buffer.from(child.slice(1)).toString('hex');
 return {public_key,address:'0x'+keccak256('0x'+public_key).slice(-40)};
}
export async function deriveLive(predecessor, view) {
 const root=await view('public_key',{domain_id:0});
 const onchain=await view('derived_public_key',{domain_id:0,path:PATH,predecessor});
 const computed=derive(root,predecessor);
 if(Buffer.from(decode(onchain.slice(10))).toString('hex')!==computed.public_key) throw Error('derived key mismatch');
 return {...computed,predecessor,path:PATH,domain_id:0};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const {view}=await import('../web/chain.mjs');
 console.log(JSON.stringify(await deriveLive(process.argv[2],(method,args)=>view('v1.signer-prod.testnet',method,args)),null,2));
}
