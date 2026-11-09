"""Required disclosure gate. Real failures are blockers, not expected-failure decorations.
Only public score/freshness/inside/attempt facts plus explicit adversary assumptions are used.
"""
from fractions import Fraction as F
import unittest

def score_interval(score, freshness, penalty=F(0)):
    # Uncapped, not saturated, R6 inside => gap=40.
    return F(score)-F(1,2)-40-freshness+penalty, F(score)+F(1,2)-40-freshness+penalty

def intersect(*ranges): return max(r[0] for r in ranges), min(r[1] for r in ranges)

class DisclosureGuard(unittest.TestCase):
    def assert_resolution(self, interval, context):
        width=interval[1]-interval[0]
        self.assertGreaterEqual(width,F(1),f'{context}: feasible coverage width {width} points < 1; finer than +/-0.5')
    def test_score_only_interior_bin_is_one_point(self):
        interval=score_interval(97,F(115,6))
        self.assertEqual(interval[1]-interval[0],F(1))
        self.assertEqual((interval[1]-interval[0])/2/40,F(1,80)) # 1.25% half width
        self.assert_resolution(interval,'interior score-only bin')
    def test_single_harbor_receipt_must_not_resolve_finer(self):
        # Harbor 99, inside, data_as_of 30h => F=115/6; public attempts imply P=0.
        # R7 necessarily restricts coverage to [0,40]; high parts_band adds [34,40].
        interval=intersect(score_interval(99,F(115,6)),(F(0),F(40)),(F(34),F(40)))
        self.assertEqual(interval,(F(118,3),F(40)))
        self.assert_resolution(interval,'Harbor boundary')
    def test_consecutive_receipts_with_one_loan_turning_unverified_must_not_resolve_finer(self):
        # Same data_as_of, inside, P=0, public scores 97/97, high coverage bands.
        # Attacker knows one loan is 1% of the book => 0.4 coverage-point loss.
        # Coverage 38.0 ->37.6 is feasible; unverified share 5% ->6% stays in same public band.
        before=score_interval(97,F(115,6));after=score_interval(97,F(115,6));loss=F(2,5)
        translated_after=(after[0]+loss,after[1]+loss)
        interval=intersect(before,translated_after,(F(34),F(40)))
        self.assertEqual(interval[1]-interval[0],F(3,5))
        self.assert_resolution(interval,'two receipts and known loan loss')

if __name__=='__main__': unittest.main(verbosity=2)
