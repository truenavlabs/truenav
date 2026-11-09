// Public trust-root loader for the verifier lane. One explicit mode; never concatenate registries.
import {readFileSync} from 'node:fs';
const schema=JSON.parse(readFileSync(new URL('../../schema/source-key-registry.schema.json',import.meta.url)));
const keyPattern=new RegExp(schema.properties.keys.items.properties.key_id.pattern);
const roles=['servicer','bank','fund_admin','custodian'];
const iso=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s.slice(0,-1)+'.000Z';
const sameKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
export class SourceRegistrySession{
 #mode;#bindings=new Map();
 constructor(mode){if(!['fixture','live'].includes(mode))throw new Error('source_registry_mode');this.#mode=mode;}
 load(registry){
  if(!sameKeys(registry,['registry_version','keys'])||registry.registry_version!=='truenav-src-v1'||!Array.isArray(registry.keys)||registry.keys.length<1||registry.keys.length>1000)throw new Error('source_registry_invalid');
  const seen=new Set();
  for(const k of registry.keys){
   if(!sameKeys(k,['key_id','role','fund_scope','public_key','valid_from','valid_until','revoked'])||typeof k.key_id!=='string'||!keyPattern.test(k.key_id)||!roles.includes(k.role)||!k.key_id.startsWith(k.role+':')||typeof k.public_key!=='string'||!/^ed25519:[0-9a-f]{64}$/.test(k.public_key)||!Array.isArray(k.fund_scope)||!k.fund_scope.length||k.fund_scope.some(f=>typeof f!=='string'||f.length<1||f.length>128||f==='*')||new Set(k.fund_scope).size!==k.fund_scope.length||typeof k.revoked!=='boolean'||!iso(k.valid_from)||!iso(k.valid_until)||k.valid_from>=k.valid_until)throw new Error('source_registry_invalid');
   if(seen.has(k.key_id))throw new Error('source_key_duplicate');seen.add(k.key_id);
   const live=k.key_id.split(':')[1].startsWith('live_');
   if(live!==(this.#mode==='live'))throw new Error('source_registry_mixed_modes');
   if(this.#bindings.has(k.key_id)&&this.#bindings.get(k.key_id)!==k.public_key)throw new Error('source_key_rebound');
  }
  for(const k of registry.keys)this.#bindings.set(k.key_id,k.public_key);
  return freeze(structuredClone(registry));
 }
}
