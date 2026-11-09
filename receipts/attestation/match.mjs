// Read-only public entry point. No injectable quote verdict, signer, deployment or transaction capability.
import {getCollateralAndVerify} from '@phala/dcap-qvl';
import {quoteFields} from '../../tee/fingerprint.mjs';
import {matchWithCapabilities,proofReference} from './match-core.mjs';
export async function fetchPublicProof(reference){
 if(!proofReference(reference))throw new Error('unsupported public proof reference');
 const response=await fetch(reference,{redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('public proof unavailable');
 const reader=response.body.getReader();const chunks=[];let count=0;
 for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>262144){await reader.cancel();throw new Error('public proof exceeds bound');}chunks.push(Buffer.from(value));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function matchPublicAttestation(args){return matchWithCapabilities(args,{fetchProof:fetchPublicProof,quoteFields,verifyQuote:getCollateralAndVerify});}
