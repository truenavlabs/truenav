"""Rc2 interface validation, no live operations or private inputs."""
import copy
import json
from pathlib import Path
import unittest
from decimal import Decimal
from jsonschema import Draft202012Validator, FormatChecker
ROOT=Path(__file__).resolve().parents[2]
def read(p): return json.loads((ROOT/p).read_text())
SCHEMA=read('schema/receipt-v3.schema.json')
V=Draft202012Validator(SCHEMA,format_checker=FormatChecker())
GOLDEN=read('schema/vectors/receipt-v3-golden.json')['vectors']
class Interfaces(unittest.TestCase):
 def test_schemas_and_golden_envelopes(self):
  for f in ['schema/receipt-v3.schema.json','schema/source-key-registry.schema.json','schema/verifier-result.schema.json']:
   Draft202012Validator.check_schema(read(f))
  for g in GOLDEN: V.validate(g['envelope'])
 def test_unknown_fields_operator_tokens_and_reserved_kinds(self):
  for field,value in [('kind','real_estate'),('kind','treasury'),('blocked_attempts','2+'),('loans_checked','<5'),('nav_gap_band','<=5pct'),('currency','EUR'),('attestation_status','verified'),('claimed_not_settled_cents','100')]:
   e=copy.deepcopy(GOLDEN[0]['envelope']);e[field]=value
   self.assertTrue(list(V.iter_errors(e)),field)
 def test_nested_extensions_and_missing_fields(self):
  for field in SCHEMA['required']:
   e=copy.deepcopy(GOLDEN[0]['envelope']);del e[field]
   self.assertTrue(list(V.iter_errors(e)),field)
  for field in ['ext','parts_x100','parts_band','commitments']:
   e=copy.deepcopy(GOLDEN[0]['envelope']);e[field]['unexpected']=0
   self.assertTrue(list(V.iter_errors(e)),field)
 def test_source_failure_is_a_closed_failure(self):
  e=copy.deepcopy(GOLDEN[0]['envelope']);e['source_key_ids'][0]['sig_ok']=False
  self.assertTrue(list(V.iter_errors(e)))
  e.update(status='verification_failed',band='red',score_x100=None,raw_score=None)
  e['holds'].append('source_signature_invalid')
  e['parts_x100']={k:None for k in e['parts_x100']};e['parts_band']={k:'unknown' for k in e['parts_band']}
  V.validate(e)
  e['source_key_ids'][0]['source']='bank'
  self.assertTrue(list(V.iter_errors(e)))
 def test_small_count_precision_and_source_registry_shape(self):
  e=copy.deepcopy(GOLDEN[0]['envelope']);e['loans_checked']='lt_5';e['pledge_coverage_bps']=7100
  self.assertTrue(list(V.iter_errors(e)));e['pledge_coverage_bps']=7500;V.validate(e)
  r={'registry_version':'truenav-src-v1','keys':[{'key_id':'servicer:sim:v1','role':'servicer','fund_scope':['harbor-credit-fund'],'public_key':'ed25519:'+'01'*32,'valid_from':'2026-01-01T00:00:00Z','valid_until':'2027-01-01T00:00:00Z','revoked':False}]}
  validator=Draft202012Validator(read('schema/source-key-registry.schema.json'),format_checker=FormatChecker())
  validator.validate(r);r['keys'][0]['private_key']='not allowed'
  self.assertTrue(list(validator.iter_errors(r)))
 def test_interval_ends_are_explicit_and_nonoverlapping(self):
  allbands=SCHEMA['x-band-intervals']
  for name,bands in allbands.items():
   endpoints=sorted({Decimal(x[k]) for x in bands.values() for k in ['lower','upper'] if x[k] is not None})
   probes=endpoints+[(a+b)/2 for a,b in zip(endpoints,endpoints[1:])]
   for point in probes:
    hits=[]
    for label,r in bands.items():
     self.assertEqual(set(r),{'lower','upper','lower_closed','upper_closed'})
     lo=None if r['lower'] is None else Decimal(r['lower']);hi=None if r['upper'] is None else Decimal(r['upper'])
     if (lo is None or point>lo or (point==lo and r['lower_closed'])) and (hi is None or point<hi or (point==hi and r['upper_closed'])):hits.append(label)
    self.assertLessEqual(len(hits),1,(name,str(point)))
  for field,token,upper in [('nav_gap_band','gt_0_lte_5pct','0.05'),('unverified_share_band','gt_25_lte_50pct','0.50')]:
   self.assertEqual(allbands[field][token]['upper'],upper);self.assertTrue(allbands[field][token]['upper_closed'])
 def test_no_operator_enum_literals(self):
  def walk(x):
   if isinstance(x,dict):
    if 'enum' in x:
     for token in x['enum']:self.assertRegex(token,r'^[a-z][a-z0-9_]*$')
    for v in x.values():walk(v)
   elif isinstance(x,list):
    for v in x:walk(v)
  walk(SCHEMA)
if __name__=='__main__': unittest.main(verbosity=2)
