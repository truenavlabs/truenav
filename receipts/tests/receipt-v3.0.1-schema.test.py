"""Approved amendment shape and immutable rc3 raw hash; no live operations."""
import copy,hashlib,json,unittest
from pathlib import Path
from jsonschema import Draft202012Validator,FormatChecker
ROOT=Path(__file__).resolve().parents[2]
def load(p):return json.loads((ROOT/p).read_text())
class Amendment(unittest.TestCase):
 def test_rc3_raw_sha256_is_unchanged(self):
  self.assertEqual(hashlib.sha256((ROOT/'schema/receipt-v3.schema.json').read_bytes()).hexdigest(),'bca1694674e7232fb53797a494ca84b0702bcf6908a14de9eb953061d5b114b2')
 def test_new_schema_is_exactly_the_approved_diff(self):
  old=load('schema/receipt-v3.schema.json');expected=copy.deepcopy(old)
  expected['$id']='urn:truenav:receipt:v3.0.1';expected['properties']['method_version']['const']='truenav-v3.0.1'
  expected['properties']['caps']['items']['enum'].append('pledge_conflict');expected['properties']['caps']['maxItems']=6
  self.assertEqual(expected,load('schema/receipt-v3.0.1.schema.json'));Draft202012Validator.check_schema(expected)
 def test_cross_version_schema_selection_has_no_fallback(self):
  schemas={v:Draft202012Validator(load(p),format_checker=FormatChecker()) for v,p in [('truenav-v3.0.0','schema/receipt-v3.schema.json'),('truenav-v3.0.1','schema/receipt-v3.0.1.schema.json')]}
  for v in load('schema/vectors/receipt-v3-golden.json')['vectors']:
   e=v['envelope'];schemas[e['method_version']].validate(e);self.assertTrue(list(schemas['truenav-v3.0.1'].iter_errors(e)))
  for v in load('schema/vectors/engine-v3-derived.json')['vectors']:
   e=v['envelope'];self.assertEqual(e['method_version'],'truenav-v3.0.1');schemas[e['method_version']].validate(e);self.assertTrue(list(schemas['truenav-v3.0.0'].iter_errors(e)))
  e=copy.deepcopy(load('schema/vectors/receipt-v3-golden.json')['vectors'][0]['envelope']);e['caps']=['pledge_conflict'];self.assertTrue(list(schemas['truenav-v3.0.0'].iter_errors(e)))
if __name__=='__main__':unittest.main(verbosity=2)
