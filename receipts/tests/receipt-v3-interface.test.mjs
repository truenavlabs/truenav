// Interface vectors only: no live calls, source fixture generation, deployment or exported signing material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, generateKeyPairSync, sign, verify, randomBytes, createPublicKey } from 'node:crypto';
import { scoreFund } from '../../engine/src/score.mjs';
const read = p => JSON.parse(fs.readFileSync(new URL('../../'+p, import.meta.url)));
const canonical = x => x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const digest = b => createHash('sha256').update(b).digest('hex');
const vectors=read('schema/vectors/receipt-v3-golden.json').vectors;
test('golden receipt and execution preimages reproduce bytes and digests; status is outside committed envelope',()=>{
 for(const v of vectors){
  const {receipt_sha256,...e}=v.envelope;
  assert.equal(canonical(e),v.receipt_preimage_utf8);
  assert.equal(Buffer.from(v.receipt_preimage_hex,'hex').toString(),v.receipt_preimage_utf8);
  assert.equal(digest(v.receipt_preimage_utf8),receipt_sha256);
  const {attestation_ref,issued_at,...b}=e;
  assert.equal(canonical(b),v.execution_preimage_utf8);
  assert.equal(Buffer.from(v.execution_preimage_hex,'hex').toString(),v.execution_preimage_utf8);
  assert.equal(digest(v.execution_preimage_utf8),v.execution_body_sha256);
  assert.ok(!Object.hasOwn(e,'attestation_status'));
 }
});
test('method artifact hash and schema pin are exact and independent of Markdown',()=>{
 const m=read('schema/methods/truenav-v3.0.0-rc3.json');
 assert.equal(m.receipt_schema_sha256,digest(fs.readFileSync(new URL('../../schema/receipt-v3.schema.json',import.meta.url))));
 for(const v of vectors)assert.equal(v.envelope.method_spec_sha256,digest(canonical(m)));
});
test('private report pins reproduce 9917 and 4284 while public scores are 99 and 43',()=>{
 const d=read('spec/nav/fixtures.json');
 for(const [i,f] of d.funds.entries()){
  const r=scoreFund(d,f,{now:d.valuation_time,certStore:d.cert_store});
  const e=vectors[i].envelope,report=vectors[i].test_private_score_report;
  assert.equal(Math.floor(Math.max(0,r.raw)*100+.5),[9917,4284][i]);
  assert.equal(report.score_x100,[9917,4284][i]);assert.equal(e.score,[99,43][i]);
  assert.equal(e.score,Math.floor(r.raw+.5));
  for(const k of ['score_x100','parts_x100','raw_score'])assert.ok(!Object.hasOwn(e,k));
  for(const k of ['gap','coverage','freshness','penalty'])assert.equal(report.parts_x100[k],Math.floor(r.pillars[k]*100+.5));
  assert.equal(report.raw_score,String(r.raw));assert.equal(e.data_as_of,f.nav_report_date);
 }
 const correction=vectors[2].envelope;
 assert.equal(correction.prev_receipt_sha256,vectors[0].envelope.receipt_sha256);
 assert.equal(correction.seq,'2');assert.equal(correction.supersedes_seq,'1');
 assert.equal(vectors[3].envelope.score,59);assert.equal(vectors[3].test_private_score_report.score_x100,5900);
 assert.deepEqual(vectors[3].envelope.caps,['yield_gap']);assert.equal(vectors[3].envelope.band,'red');
});
test('benchmark late cohorts use primary and complementary suppression; refused attempt is not a book conflict',()=>{
 const d=read('spec/nav/fixtures.json');
 for(const [i,f] of d.funds.entries()){
  const keys=['dpd_1_30','dpd_31_60','dpd_61_90','dpd_91_plus'];
  const map={dpd_1_30:'dpd_1_30',dpd_31_60:'dpd_31_60',dpd_61_90:'dpd_61_90',dpd_91_plus:'dpd_over_90'};
  const expected=Object.fromEntries(keys.map(k=>[k,f.loans.filter(l=>l.principal+l.accrued-l.repaid>0&&l.bucket===map[k]).length]));
  assert.deepEqual(vectors[i].test_expected_private_cohorts,expected);
  for(const k of keys)assert.equal(vectors[i].envelope.late_loan_cohorts[k],expected[k]>0?'lt_5':'suppressed');
 }
 assert.equal(vectors[1].envelope.pledge_result,'clear');assert.equal(vectors[1].envelope.blocked_attempts,'one');
 assert.ok(vectors[1].envelope.holds.includes('recent_pledge_attempt'));
});
test('private score report commitments bind each precision field with TEST-only salt',()=>{
 for(const v of vectors){const e=v.envelope,r=v.test_private_score_report;
  for(const k of ['score_x100','parts_x100','raw_score']){
   const pre=Buffer.concat([lp('truenav-v3'),lp('score_exact:'+k),lp(Buffer.from(e.request_nonce,'hex')),lp(Buffer.from(r.test_salt_hex,'hex')),lp(canonical(r[k]))]);
   assert.equal(digest(pre),e.commitments[k]);
  }
 }
});
test('fixed ladder vectors include boundaries and positive/negative half ties',()=>{
 const cases=read('schema/vectors/nav-rounding.json').vectors;
 for(const v of cases){
  const x=BigInt(v.input_cents),a=x<0n?-x:x;let step;
  outer:for(let power=1n;power<=10n**40n;power*=10n)for(const m of [1n,2n,5n]){
   const candidate=m*power*100n;
   if(candidate>=1000000n&&1000n*candidate>=a){step=candidate;break outer;}
  }
  const rounded=((2n*a+step)/(2n*step))*step*(x<0n?-1n:1n);
  assert.equal(String(step),v.step_cents);assert.equal(String(rounded),v.rounded_cents);
 }
});
test('CI enumeration: no small checked-count/coverage pair identifies a unique positive count below five',()=>{
 const expected=read('schema/vectors/coverage-enumeration.json');const pairs=new Map();
 for(let n=1;n<=expected.max_open_loans;n++)for(let c=1;c<=Math.min(n,9);c++){
  const label=c<5?'lt_5':'from_5_to_9';const coverage=2500*Math.floor(4*c/n);const key=label+':'+coverage;
  if(!pairs.has(key))pairs.set(key,new Set());pairs.get(key).add(c);
 }
 for(const [key,counts]of pairs)if(key.startsWith('lt_5:'))assert.ok(counts.size>=2,'positive count inversion');
 for(const e of expected.pairs)assert.deepEqual([...pairs.get(e.loans_checked+':'+e.coverage_bps)].sort((a,b)=>a-b),e.possible_completed_counts);
 assert.equal(pairs.size,expected.pairs.length);
});
const lp = bytes => {const b=Buffer.from(bytes),n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);};
test('source signature framing verifies the digest bytes and rejects role/fund/revision substitution',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const fields=['truenav-src-v1','servicer','servicer:sim:v1',canonical({network:'near_testnet',receipts_contract:'receipts.tnlab-718ca9.testnet',fund_account:'harbor.sim.testnet',token_id:'harbor-credit-fund'}),canonical({period_start:'2026-10-01',period_end:'2026-11-01'}),'1','2026-11-09T06:00:00Z',Buffer.alloc(32)];
 const preimage=Buffer.concat(fields.map(lp));const bytes=createHash('sha256').update(preimage).digest();const signature=sign(null,bytes,privateKey);
 assert.ok(verify(null,bytes,publicKey,signature));
 assert.ok(!verify(null,Buffer.from(bytes.toString('hex')),publicKey,signature));
 for(const i of [1,3,5]){const changed=[...fields];changed[i]=Buffer.from('changed');const d=createHash('sha256').update(Buffer.concat(changed.map(lp))).digest();assert.ok(!verify(null,d,publicKey,signature));}
 assert.equal(preimage.readUInt32BE(0),14); // truenav-src-v1, bytes not chars+terminator
});
test('H framing distinguishes canonical null, string null, labels and nonces without exporting salt',()=>{
 const salt=randomBytes(32),nonce=Buffer.alloc(32,1);
 const h=(label,value,n=nonce)=>digest(Buffer.concat([lp('truenav-v3'),lp(label),lp(n),lp(salt),lp(canonical(value))]));
 assert.equal(Buffer.from(canonical(null)).toString('hex'),'6e756c6c');
 assert.notEqual(h('inputs',null),h('inputs','null'));assert.notEqual(h('inputs',null),h('cash',null));assert.notEqual(h('inputs',null),h('inputs',null,Buffer.alloc(32,2)));
});

test('H known answers cover every label class with explicitly TEST-only zero salt and nonce',()=>{
 const kat=read('schema/vectors/commitment-known-answers.json');
 const labels=read('schema/methods/truenav-v3.0.0-rc3.json').commitment_labels;
 assert.match(kat.classification,/TEST ONLY/);assert.equal(kat.test_salt_hex,'00'.repeat(32));assert.equal(kat.nonce_hex,'00'.repeat(32));
 assert.deepEqual(kat.vectors.map(v=>v.label),labels);
 for(const v of kat.vectors){
  const pre=Buffer.concat([lp('truenav-v3'),lp(v.label),lp(Buffer.from(kat.nonce_hex,'hex')),lp(Buffer.from(kat.test_salt_hex,'hex')),lp(canonical(v.value))]);
  assert.equal(pre.toString('hex'),v.preimage_hex);assert.equal(digest(pre),v.sha256);
 }
});
test('public RFC 8032 verification key checks the frozen source framing signature known answer',()=>{
 const v=read('schema/vectors/source-signature-known-answer.json');
 const payloadDigest=digest(canonical(v.payload));assert.equal(payloadDigest,v.payload_sha256);
 const fields=['truenav-src-v1',v.source,v.key_id,canonical(v.scope),canonical(v.period),v.revision,v.data_as_of,Buffer.from(payloadDigest,'hex')];
 const pre=Buffer.concat(fields.map(lp));assert.equal(pre.toString('hex'),v.preimage_hex);assert.equal(digest(pre),v.digest_sha256);
 const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(v.public_key_hex,'hex')]),format:'der',type:'spki'});
 assert.ok(verify(null,Buffer.from(v.digest_sha256,'hex'),pub,Buffer.from(v.signature_hex,'hex')));
 assert.ok(!verify(null,Buffer.from(v.digest_sha256),pub,Buffer.from(v.signature_hex,'hex')));
});
