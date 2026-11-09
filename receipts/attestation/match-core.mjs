// Internal capability boundary. Public callers use match.mjs; tests inject simulated capabilities here only.
import {createHash} from 'node:crypto';
import {receiptPolicy} from './receipt-policy.mjs';
import {taskHash} from '../../tee/fingerprint.mjs';
export function canonical(x){
 if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);
 if(typeof x==='number'){if(!Number.isSafeInteger(x))throw new Error('unsafe public number');return JSON.stringify(x);}
 if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
 if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
 throw new Error('invalid public JSON');
}
export const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export function proofReference(x){
 if(typeof x!=='string'||x.length>256)return false;
 const prefix='https://testnet-api.outlayer.ai/attestations/';if(!x.startsWith(prefix))return false;const tail=x.slice(prefix.length);
 if(/^by-request\/(0|[1-9][0-9]{0,19})$/.test(tail))return BigInt(tail.slice(11))<=18446744073709551615n;
 return /^by-tx\/[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(tail)||/^by-call\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tail);
}
const result=(status,reason)=>({status,reason});
export function bodyOf(envelope){const b=structuredClone(envelope);for(const k of ['receipt_sha256','attestation_ref','issued_at'])delete b[k];return b;}
/** E and the record must come from finalized contract views; expected context from its original execution request.
 * This component matches the public proof. Chain anchoring and full frozen-schema validation remain the caller's
 * verifier responsibilities. It never treats input_sha256 (the salted private manifest) as OutLayer input_hash.
 */
export async function matchWithCapabilities({envelope:e,record:r,context:c},caps){
 try{
  let policy;try{policy=receiptPolicy(e);}catch{return result('invalid','schema_invalid');}
  const {schema,method}=policy;const fields=Object.keys(schema.properties).sort();
  if(!e||e.receipt_version!=='3'||e.network!=='near_testnet'||e.receipts_contract!=='receipts.tnlab-718ca9.testnet'||e.attestation_ref!==null||canonical(Object.keys(e).sort())!==canonical(fields))return result('invalid','schema_invalid');
  const {receipt_sha256,...preimage}=e;if(!hash(receipt_sha256)||sha(canonical(preimage))!==receipt_sha256)return result('invalid','hash_mismatch');
  if(e.method_spec_sha256!==sha(canonical(method)))return result('invalid','method_hash_mismatch');
  if(!r)return result('unavailable','attestation_missing');
  if(Object.keys(r).sort().join(',')!==['token_id','seq','receipt_sha256','body_sha256','proof_ref','proof_scheme','attester','block_height'].sort().join(',')||typeof r.attester!=='string'||!/^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/.test(r.attester)||typeof r.block_height!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(r.block_height)||BigInt(r.block_height)>18446744073709551615n)return result('invalid','attestation_unbound');
  const bodyHash=sha(canonical(bodyOf(e)));
  if(r.token_id!==e.token_id||r.seq!==e.seq||r.receipt_sha256!==receipt_sha256||r.body_sha256!==bodyHash||r.proof_scheme!=='outlayer_tdx_v1'||!proofReference(r.proof_ref))return result('invalid','attestation_unbound');
  if(!c||!hash(c.engine_code_sha256)||!hash(c.input_hash)||typeof c.caller_account_id!=='string'||!c.caller_account_id||typeof c.project_id!=='string'||!c.project_id||!Array.isArray(c.approved_measurements)||!c.approved_measurements.length)return result('unavailable','evidence_unavailable');
  if(e.engine_code_sha256!==c.engine_code_sha256||e.engine_version_key!==c.engine_code_sha256)return result('invalid','engine_mismatch');
  let proof;try{proof=await caps.fetchProof(r.proof_ref);}catch{return result('unavailable','evidence_unavailable');}
  if(typeof c.fund_id!=='string'||!c.fund_id||c.fund_id!==e.fund_id)return result('invalid','fund_id_unbound');
  if(!proof||proof.task_type!=='execute'||proof.build_target!=='wasm32-wasip2'||proof.output_hash!==bodyHash||proof.input_hash!==c.input_hash||proof.wasm_hash!==c.engine_code_sha256||proof.executed_wasm_sha256!==c.engine_code_sha256||proof.caller_account_id!==c.caller_account_id||proof.project_id!==c.project_id)return result('invalid','attestation_unbound');
  for(const k of ['task_id','timestamp','block_height'])if(proof[k]!==null&&proof[k]!==undefined&&(!Number.isSafeInteger(proof[k])||proof[k]<0))return result('invalid','attestation_invalid');
  if(typeof proof.tdx_quote!=='string'||proof.tdx_quote.length>100000)return result('invalid','attestation_invalid');
  const quote=Buffer.from(proof.tdx_quote,'base64');const measurement=caps.quoteFields(quote);
  if(measurement.report_data!==taskHash(proof)+'0'.repeat(64))return result('invalid','attestation_unbound');
  if(!c.approved_measurements.some(a=>['mrtd','rtmr0','rtmr1','rtmr2','rtmr3'].every(k=>typeof a[k]==='string'&&a[k].toLowerCase()===measurement[k])))return result('invalid','attestation_invalid');
  let verified;try{verified=await caps.verifyQuote(quote);}catch{return result('invalid','attestation_invalid');}
  if(verified?.status!=='UpToDate')return result('invalid','attestation_invalid');
  // OutLayer proof.timestamp is Unix seconds (u64 LE in taskHash). 7 days, pending a product call. 5 minutes of future skew.
  const QUOTE_MAX_AGE_SEC=7*24*60*60;
  const QUOTE_FUTURE_SKEW_SEC=5*60;
  const ts=proof.timestamp;
  if(typeof ts!=='number'||!Number.isSafeInteger(ts)||ts<0)return result('invalid','attestation_expired');
  const nowSec=Math.floor(Date.now()/1000);
  if(ts>nowSec+QUOTE_FUTURE_SKEW_SEC||nowSec-ts>QUOTE_MAX_AGE_SEC)return result('invalid','attestation_expired');
  return {status:'attested',reason:'ok',token_id:e.token_id,fund_id:e.fund_id,seq:e.seq,receipt_sha256,body_sha256:bodyHash,proof_ref:r.proof_ref};
 }catch{return result('invalid','attestation_invalid');}
}
