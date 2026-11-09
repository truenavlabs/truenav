"""All-public-envelope disclosure regression gate; private sidecars never enter inference."""
import copy
import json
import hashlib
from decimal import Decimal as D, localcontext
from pathlib import Path
import unittest
from receipt_v3_observer import infer,load,Interval,nav_cell,assert_not_narrower,POLICY,SCHEMA

GOLD=load('schema/vectors/receipt-v3-golden.json')['vectors']
EXPECTED=load('schema/vectors/disclosure-bounds.json')
CASES=load('schema/vectors/disclosure-observer-cases.json')['cases']
MONEY=('reported_nav','trueval','truerange_low','truerange_high')

def observation_pair(case):
 before=infer(case['before']);after=infer(case['after'])
 with localcontext() as ctx:
  ctx.prec=85
  loss=D(case['known_side_information']['coverage_loss_points'])
  result={'coverage':before['coverage'].intersect(after['coverage'].shift(loss))}
  if case['known_side_information']['money_values_unchanged']:
   for name in MONEY:result[name]=before[name].intersect(after[name])
 return result

class DisclosureGuard(unittest.TestCase):
 def test_every_golden_uses_every_public_field_and_has_a_frozen_bound(self):
  self.assertEqual(set(POLICY['public_fields']),set(SCHEMA['properties']))
  self.assertEqual({v['name'] for v in GOLD},set(EXPECTED['funds']))
  for vector in GOLD:
   actual=infer(vector['envelope']);bounds=EXPECTED['funds'][vector['name']]['bounds']
   self.assertEqual(set(actual),set(bounds),vector['name'])
   assert_not_narrower(actual,bounds)
 def test_frozen_observer_and_bounds_files_are_pinned(self):
  method=load('schema/methods/truenav-v3.0.0-rc3.json')['score_privacy_requirement']
  for file,key in [('schema/vectors/disclosure-bounds.json','disclosure_bounds_sha256'),('schema/vectors/disclosure-policy.json','observer_policy_sha256')]:
   b=json.dumps(load(file),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
   self.assertEqual(hashlib.sha256(b).hexdigest(),method[key])
  source=(Path(__file__).with_name('receipt_v3_observer.py')).read_bytes()
  self.assertEqual(hashlib.sha256(source).hexdigest(),method['observer_implementation_sha256'])
 def test_fully_verified_is_accepted_exact_coverage_not_old_half_point_rule(self):
  for vector in GOLD:
   if vector['envelope']['unverified_share_band']=='zero':
    actual=infer(vector['envelope'])
    self.assertEqual(actual['coverage'].json(),Interval(40,40,True,True).json())
    self.assertEqual(actual['parts_x100.coverage'].lo,D(4000))
 def test_meridian_derives_r6_r7_r13_and_score_constraints_not_a_harbor_constant(self):
  vector=next(v for v in GOLD if v['envelope']['unverified_share_band']!='zero')
  actual=infer(vector['envelope'])
  self.assertGreater(actual['coverage'].lo,D('35.960308'))
  self.assertLess(actual['coverage'].lo,D('35.960310'))
  self.assertFalse(actual['coverage'].lc);self.assertEqual(actual['coverage'].hi,D(40))
  modified=copy.deepcopy(vector['envelope']);modified['unverified_share_band']='zero'
  modified['receipt_sha256']=hashlib.sha256(json.dumps({k:v for k,v in modified.items() if k!='receipt_sha256'},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
  self.assertEqual(infer(modified)['coverage'].lo,D(40))
 def test_correction_and_capped_envelopes_are_analysed_including_cap_saturation(self):
  correction=next(v for v in GOLD if v['envelope']['supersedes_seq'] is not None)
  earlier=next(v for v in GOLD if v['envelope']['receipt_sha256']==correction['envelope']['prev_receipt_sha256'])
  a=infer(earlier['envelope']);b=infer(correction['envelope'])
  joint={k:a[k].intersect(b[k]) for k in a}
  assert_not_narrower(joint,EXPECTED['pairs']['harbor_correction']['bounds'])
  for v in GOLD:
   if v['envelope']['caps']:
    result=infer(v['envelope']);self.assertEqual(result['score_x100'].lo,D(5900))
    self.assertEqual(result['raw_score'].lo,result['raw_score'].hi)
 def test_consecutive_loan_change_derives_accepted_window_from_public_vectors(self):
  for case in CASES:
   actual=observation_pair(case)
   self.assertAlmostEqual(actual['coverage'].width(),D('0.6'),places=30)
   assert_not_narrower(actual,EXPECTED['pairs'][case['name']]['bounds'])
 def test_nav_trueval_range_and_midpoint_never_refine_public_ladder_cells(self):
  for v in GOLD:
   actual=infer(v['envelope'])
   for name in MONEY:
    self.assertEqual(actual[name].json(),nav_cell(v['envelope'][name]).json())
   self.assertIsNone(actual['cash_amounts'].hi)
   self.assertIsNone(actual['original_loan_principal'].hi)
   self.assertGreater(actual['loan_outstanding'].width(),D(1000000))
 def test_midpoint_attack_is_rejected_if_it_refines_a_rounded_trueval(self):
  # A different valid high-endpoint cell can refine TrueVal through symmetry.
  e=copy.deepcopy(GOLD[0]['envelope']);e['truerange_high']='1000000000'
  e['receipt_sha256']=hashlib.sha256(json.dumps({k:v for k,v in e.items() if k!='receipt_sha256'},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
  actual=infer(e);baseline=nav_cell(e['trueval'])
  self.assertLess(actual['trueval'].width(),baseline.width())
  with self.assertRaises(AssertionError):
   assert_not_narrower(actual,{'trueval':{**baseline.json(),'policy':'public_rounding'}})
 def test_explicit_zero_exception_cannot_silently_refine_a_cash_band(self):
  e=copy.deepcopy(GOLD[0]['envelope'])
  e['exceptions']=[{'code':'claimed_not_settled','band':'none'}]
  e['receipt_sha256']=hashlib.sha256(json.dumps({k:v for k,v in e.items() if k!='receipt_sha256'},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
  actual=infer(e)
  self.assertEqual(actual['cash_match_band'].lo,D(1));self.assertEqual(actual['cash_match_band'].hi,D(1))
  with self.assertRaises(AssertionError):
   assert_not_narrower(actual,EXPECTED['funds'][GOLD[0]['name']]['bounds'])
 def test_future_finer_inference_fails_for_money_bands_and_nonzero_coverage(self):
  v=next(v for v in GOLD if v['envelope']['unverified_share_band']!='zero')
  for field in ('coverage','reported_nav','trueval','cash_match_band','cash_amounts','loan_outstanding'):
   actual=infer(v['envelope']);i=actual[field]
   if i.hi is None:actual[field]=Interval(i.lo,i.lo+1)
   else:actual[field]=Interval(i.hi-D('.01'),i.hi)
   with self.assertRaises(AssertionError,msg=field):assert_not_narrower(actual,EXPECTED['funds'][v['name']]['bounds'])
 def test_new_fields_external_proof_and_private_report_keys_cannot_be_ignored(self):
  for field,value in [('cash_total_cents','100'),('score_x100',9917),('hidden_loan_size_cents','100')]:
   e=copy.deepcopy(GOLD[0]['envelope']);e[field]=value
   with self.assertRaises(Exception):infer(e)
  e=copy.deepcopy(GOLD[0]['envelope']);e['attestation_ref']='sha256:'+'a'*64
  e['receipt_sha256']=hashlib.sha256(json.dumps({k:v for k,v in e.items() if k!='receipt_sha256'},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
  with self.assertRaises(ValueError):infer(e)
 def test_private_expected_values_and_test_salt_are_not_observer_inputs(self):
  for v in GOLD:
   expected={k:x.json() for k,x in infer(v['envelope']).items()}
   poisoned=copy.deepcopy(v);poisoned['test_private_score_report']={'score_x100':1,'test_salt_hex':'ff'*32}
   poisoned['test_expected_private_cohorts']={}
   self.assertEqual(expected,{k:x.json() for k,x in infer(poisoned['envelope']).items()})
 def test_public_derived_intervals_contain_the_private_test_answers(self):
  # Private values validate the result AFTER inference; they never constrain the observer.
  for vector in GOLD:
   actual=infer(vector['envelope']);private=vector['test_private_score_report']
   values={'score_x100':private['score_x100'],'raw_score':D(private['raw_score'])}
   values.update({'parts_x100.'+k:v for k,v in private['parts_x100'].items()})
   for name,value in values.items():
    interval=actual[name];value=D(value)
    if interval.lo is not None:self.assertGreaterEqual(value+D('1e-12'),interval.lo,name)
    if interval.hi is not None:self.assertLessEqual(value-D('1e-12'),interval.hi,name)
 def test_fixed_ladder_inverse_includes_boundary_step_changes(self):
  # A published $10M does NOT imply just a symmetric $10k cell.
  actual=nav_cell('1000000000')
  self.assertEqual(actual.lo,D(999500000));self.assertEqual(actual.hi,D(1001000000))
  self.assertEqual(nav_cell('-1000000000').lo,-actual.hi)

if __name__=='__main__': unittest.main(verbosity=2)
