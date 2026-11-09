// Version dispatch is exact. A v3.0.0 envelope never borrows the amendment's cap enum.
import {readFileSync} from 'node:fs';
const read=p=>JSON.parse(readFileSync(new URL('../../'+p,import.meta.url)));
const policies=new Map([
 ['truenav-v3.0.0',{schema:read('schema/receipt-v3.schema.json'),method:read('schema/methods/truenav-v3.0.0-rc3.json')}],
 ['truenav-v3.0.1',{schema:read('schema/receipt-v3.0.1.schema.json'),method:read('schema/methods/truenav-v3.0.1.json')}]
]);
export function receiptPolicy(envelope){
 const p=policies.get(envelope?.method_version);
 if(!p||envelope.receipt_version!=='3'||!Array.isArray(envelope.caps)||envelope.caps.some(c=>!p.schema.properties.caps.items.enum.includes(c))||new Set(envelope.caps).size!==envelope.caps.length)throw new Error('schema_invalid');
 if(envelope.method_version==='truenav-v3.0.1'){
  const conflict=envelope.pledge_result==='conflict';
  if(conflict!==envelope.caps.includes('pledge_conflict')||conflict&&(envelope.band!=='red'||envelope.score!==null&&(!Number.isInteger(envelope.score)||envelope.score>59)))throw new Error('conflict_cap_invalid');
 }
 return structuredClone(p);
}
