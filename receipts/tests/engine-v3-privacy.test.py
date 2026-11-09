"""Run the unchanged all-public-field observer on actual engine-derived outputs."""
import unittest
from decimal import Decimal as D
from receipt_v3_1_observer import infer, load, assert_not_narrower, nav_cell

DERIVED=load('schema/vectors/engine-v3-derived.json')['vectors']
BOUNDS=load('schema/vectors/disclosure-bounds.json')
class EngineDisclosureGuard(unittest.TestCase):
 def test_all_four_engine_outputs_meet_the_same_frozen_disclosure_bounds(self):
  self.assertEqual({v['name'] for v in DERIVED},set(BOUNDS['funds']))
  for v in DERIVED:
   with self.subTest(vector=v['name']):assert_not_narrower(infer(v['envelope']),BOUNDS['funds'][v['name']]['bounds'])
 def test_engine_private_answers_are_inside_public_observer_intervals(self):
  for v in DERIVED:
   a=infer(v['envelope']);r=v['private_TEST_report']
   answers={k:r[k] for k in ('score_x100','raw_score')}
   answers.update(r['exact'])
   answers.update({'parts_x100.'+k:x for k,x in r['parts_x100'].items()})
   for k,x in answers.items():
    with self.subTest(vector=v['name'],quantity=k):
     x=D(str(x));i=a[k]
     if i.lo is not None:self.assertGreaterEqual(x+D('1e-10'),i.lo)
     if i.hi is not None:self.assertLessEqual(x-D('1e-10'),i.hi)
 def test_engine_correction_pair_keeps_the_accepted_joint_bounds(self):
  vectors={v['name']:v['envelope'] for v in DERIVED}
  a=infer(vectors['harbor']);b=infer(vectors['harbor_correction'])
  self.assertEqual(vectors['harbor_correction']['prev_receipt_sha256'],vectors['harbor']['receipt_sha256'])
  joint={k:a[k].intersect(b[k]) for k in a}
  assert_not_narrower(joint,BOUNDS['pairs']['harbor_correction']['bounds'])
 def test_consecutive_engine_outputs_keep_the_accepted_point_six_window(self):
  for case in load('schema/vectors/engine-v3-derived.json')['temporal_cases']:
   a=infer(case['before']);b=infer(case['after']);loss=D(case['known_side_information']['coverage_loss_points'])
   joint={'coverage':a['coverage'].intersect(b['coverage'].shift(loss))}
   assert_not_narrower(joint,{'coverage':BOUNDS['pairs']['loan_turns_unverified']['bounds']['coverage']})
   for envelope in (case['before'],case['after']):
    observed=infer(envelope)
    for name in ('reported_nav','trueval','truerange_low','truerange_high'):
     self.assertGreaterEqual(observed[name].width(),nav_cell(envelope[name]).width()-D('1e-12'))
   self.assertGreaterEqual(joint['coverage'].width(),D('.6')-D('1e-12'))
 def test_engine_pins_are_public_whole_and_private_hundredths(self):
  for v,whole,precise in zip(DERIVED[:2],(99,43),(9917,4284)):
   self.assertEqual(v['envelope']['score'],whole);self.assertEqual(v['private_TEST_report']['score_x100'],precise)
 def test_nav_midpoint_never_refines_the_engine_rounding_cells(self):
  for v in DERIVED:
   a=infer(v['envelope'])
   for k in ('reported_nav','trueval','truerange_low','truerange_high'):
    self.assertGreaterEqual(a[k].width(),nav_cell(v['envelope'][k]).width()-D('1e-12'))
 def test_active_conflict_cap_does_not_refine_private_money_or_coverage(self):
  for v in load('schema/vectors/engine-v3-derived.json')['conflict_cases']:
   e=v['envelope'];r=v['private_TEST_report'];observed=infer(e)
   self.assertEqual(e['pledge_result'],'conflict');self.assertIn('pledge_conflict',e['caps']);self.assertLessEqual(e['score'],59);self.assertEqual(e['band'],'red')
   self.assertGreaterEqual(observed['coverage'].width(),D('.6')-D('1e-12'))
   for k in ('reported_nav','trueval','truerange_low','truerange_high'):
    self.assertGreaterEqual(observed[k].width(),nav_cell(e[k]).width()-D('1e-12'))
    self.assertGreaterEqual(D(r['exact'][k]),observed[k].lo);self.assertLessEqual(D(r['exact'][k]),observed[k].hi)
   answers={k:r[k] for k in ('score_x100','raw_score')};answers.update({'parts_x100.'+k:x for k,x in r['parts_x100'].items()})
   for k,x in answers.items():
    i=observed[k];x=D(str(x))
    if i.lo is not None:self.assertGreaterEqual(x+D('1e-10'),i.lo)
    if i.hi is not None:self.assertLessEqual(x-D('1e-10'),i.hi)
if __name__=='__main__':unittest.main(verbosity=2)
