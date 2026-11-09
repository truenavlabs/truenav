"""Public-envelope disclosure observer for the frozen v3 policy.
No private report, test sidecar or expected disclosure bound enters infer().
"""
import json
import hashlib
from pathlib import Path
from decimal import Decimal as D, localcontext, getcontext
from datetime import datetime
from jsonschema import Draft202012Validator, FormatChecker
getcontext().prec=85
ROOT=Path(__file__).resolve().parents[2]
def load(p): return json.loads((ROOT/p).read_text())
METHOD=load('schema/methods/truenav-v3.0.0-rc3.json')
SCHEMA=load('schema/receipt-v3.schema.json')
POLICY=load('schema/vectors/disclosure-policy.json')
VALIDATOR=Draft202012Validator(SCHEMA,format_checker=FormatChecker())
EPS=D('1e-12')
class Interval:
 def __init__(self,lo=None,hi=None,lc=True,hc=False):
  self.lo=None if lo is None else D(lo);self.hi=None if hi is None else D(hi);self.lc=lc;self.hc=hc
  if self.lo is not None and self.hi is not None:
   if self.lo>self.hi+EPS:raise ValueError('inconsistent public constraints')
   if abs(self.lo-self.hi)<EPS:self.lo=self.hi=(self.lo+self.hi)/2;self.lc=self.hc=True
 def intersect(self,o):
  lo=self.lo if o.lo is None else o.lo if self.lo is None else max(self.lo,o.lo)
  hi=self.hi if o.hi is None else o.hi if self.hi is None else min(self.hi,o.hi)
  lc=(self.lc if lo==self.lo else True) and (o.lc if lo==o.lo else True)
  hc=(self.hc if hi==self.hi else True) and (o.hc if hi==o.hi else True)
  return Interval(lo,hi,lc,hc)
 def shift(self,n):return Interval(None if self.lo is None else self.lo+n,None if self.hi is None else self.hi+n,self.lc,self.hc)
 def width(self):return None if self.lo is None or self.hi is None else self.hi-self.lo
 def json(self):
  def fmt(n):
   if n is None:return None
   with localcontext() as c:c.prec=70;return str(+n)
  return {'lower':fmt(self.lo),'upper':fmt(self.hi),'lower_closed':self.lc,'upper_closed':self.hc}
 def part_x100(self):
  def r(n):return ((n*100+D('.5')).to_integral_value(rounding='ROUND_FLOOR'))
  return Interval(None if self.lo is None else r(self.lo),None if self.hi is None else r(self.hi),True,True)
def band(name,token):
 r=METHOD['intervals'].get(name,{}).get(token)
 return Interval() if r is None else Interval(r['lower'],r['upper'],r['lower_closed'],r['upper_closed'])
def nav_cell(value):
 """Invert BOTH fixed-ladder selection and nearest rounding; units are cents."""
 if value is None:return Interval()
 y=D(value)
 if y==0:return Interval(-500000,500000,False,False)
 if y<0:
  a=nav_cell(str(-y));return Interval(-a.hi,-a.lo,a.hc,a.lc)
 candidates=[];previous=D(0)
 for k in range(30):
  for m in (1,2,5):
   step=D(m)*D(10)**k*100
   if step<1000000:continue
   if y%step==0:
    r=Interval(y-step/2,y+step/2,True,False)
    region=Interval(0 if step==1000000 else previous*1000,step*1000,step==1000000,True)
    try:candidates.append(r.intersect(region))
    except ValueError:pass
   previous=step
   if step>max(y,1000000)*4:
    if not candidates:raise ValueError('not a valid rounded NAV value')
    return Interval(min(x.lo for x in candidates),max(x.hi for x in candidates),candidates[0].lc,candidates[-1].hc)
 raise ValueError('NAV range unsupported')
def infer(envelope):
 with localcontext() as ctx:
  ctx.prec=85
  VALIDATOR.validate(envelope)
  if set(envelope)!=set(POLICY['public_fields']):raise ValueError('unmodelled public envelope field')
  for k,category in POLICY['public_fields'].items():
   if category not in POLICY['categories']:raise ValueError('unmodelled public field category')
  e=envelope
  canonical=lambda x:json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
  if e['method_spec_sha256']!=hashlib.sha256(canonical(METHOD)).hexdigest():raise ValueError('untrusted method artifact')
  if e['receipt_sha256']!=hashlib.sha256(canonical({k:v for k,v in e.items() if k!='receipt_sha256'})).hexdigest():raise ValueError('invalid public receipt hash')
  if e['attestation_ref'] is not None:raise ValueError('external evidence requires an observer input expansion')
  if e['status']!='scored' or e['score'] is None or e['data_as_of'] is None:raise ValueError('golden observer requires a scored, timestamped envelope')
  # Identity/provenance select the fixed USD/testnet/credit method; salts make hashes opaque.
  # Counts/cohorts classify positions, not their dollar sizes. Source checks/proof identity expose no dollars.
  age=max(D(0),D(str((datetime.fromisoformat(e['valuation_time'])-datetime.fromisoformat(e['data_as_of'])).total_seconds()))/3600)
  f=D(20) if age<=24 else D(0) if age>=168 else D(str(20*((168-float(age))/144))) # legacy R8 operation order
  fpart=Interval(f,f,True,True).intersect(band('parts_band.freshness',e['parts_band']['freshness']))
  p=band('parts_band.penalty',e['parts_band']['penalty']).intersect(Interval(0,None))
  if 'recent_pledge_attempt' in e['holds']:p=p.intersect(Interval(D('7.5'),None))
  c=band('parts_band.coverage',e['parts_band']['coverage']).intersect(Interval(0,40,True,True))
  g=band('parts_band.nav_gap',e['parts_band']['nav_gap']).intersect(Interval(0,40,True,True))
  ng=band('nav_gap_band',e['nav_gap_band'])
  if e['nav_result']=='inside':g=g.intersect(Interval(40,40,True,True))
  elif ng.lo is not None:
   # R6 G=40*max(0,1-10*gap_ratio).
   g=g.intersect(Interval(max(D(0),40-400*ng.hi) if ng.hi is not None else 0,max(D(0),40-400*ng.lo),ng.hc,ng.lc))
  score=D(e['score']);cap=D(59 if e['caps'] else 100)
  if score>cap:raise ValueError('score contradicts cap')
  raw=Interval(None if score==0 else score-D('.5'),None if score==cap else score+D('.5'),score!=0,False)
  nav={k:nav_cell(e[k]) for k in ('reported_nav','trueval','truerange_low','truerange_high')}
  # Symmetric TrueRange: midpoint=exact TrueVal, allowing one cent for private endpoint conversion.
  for _ in range(8):
   tv,lo,hi=nav['trueval'],nav['truerange_low'],nav['truerange_high']
   if any(x.lo is None or x.hi is None for x in (tv,lo,hi)):break
   nav['trueval']=tv.intersect(Interval((lo.lo+hi.lo-1)/2,(lo.hi+hi.hi+1)/2))
   tv=nav['trueval']
   nav['truerange_low']=lo.intersect(Interval(2*tv.lo-hi.hi-1,2*tv.hi-hi.lo+1))
   nav['truerange_high']=hi.intersect(Interval(2*tv.lo-lo.hi-1,2*tv.hi-lo.lo+1))
  # R13 zero: P=L and LIH<=L, hence R7=40 or denominator-zero=0.
  # These goldens' positive coverage bands rule out zero; never apply this to arbitrary unscored funds.
  if e['unverified_share_band']=='zero':
   if e['pledge_result']!='clear' or e['pledge_coverage_bps']!=10000:raise ValueError('fully verified signal contradicts registry coverage')
   c=c.intersect(Interval(40,40,True,True))
  # Exact score-band projections and R6/R7/R13 coupling for outside-high goldens.
  # T=max(LIH,L), T-P<=U, D_R13<=max(head,T); so C>=40*(1-u*max(head/T,1)).
  # outside_high: LIH=high+TrueVal*(40-G)/400. The minimum is at public cell edges.
  u=band('unverified_share_band',e['unverified_share_band'])
  def min_c(gap):
   lower=c.lo
   if e['nav_result']=='outside_high' and u.hi is not None and nav['reported_nav'].hi is not None:
    t=nav['truerange_high'].lo+nav['trueval'].lo*(40-gap)/400
    if t>0:lower=max(lower,40*(1-u.hi*max(nav['reported_nav'].hi/t,D(1))))
   return lower
  slo=None if raw.lo is None else raw.lo-f+p.lo
  shi=None if raw.hi is None or p.hi is None else raw.hi-f+p.hi
  gl=g.lo if slo is None or c.hi is None else max(g.lo,slo-c.hi)
  gh=g.hi if shi is None else min(g.hi,shi-c.lo)
  if shi is not None and min_c(gh)+gh>shi:
   left,right=gl,gh
   for _ in range(260):
    mid=(left+right)/2
    if min_c(mid)+mid>shi:right=mid
    else:left=mid
   gh=(left+right)/2
  c_lo=max(c.lo,min_c(gh),slo-gh if slo is not None else c.lo)
  c_hi=min(c.hi,shi-gl if shi is not None else c.hi)
  c_hc=c.hc if c_hi==c.hi else False
  c=Interval(c_lo,c_hi,False if e['nav_result']=='outside_high' else c.lc,c_hc)
  g=Interval(gl,gh,g.lc,False if e['nav_result']=='outside_high' else g.hc)
  min_sum=gl+min_c(gl)
  max_sum=gh+c.hi if shi is None else min(shi,gh+c.hi)
  p=p.intersect(Interval(None if raw.hi is None else min_sum+f-raw.hi,None if raw.lo is None else max_sum+f-raw.lo,False,False))
  # Project total using feasible part sums; exact fully-verified vectors reveal raw too, intentionally.
  if c.lo==c.hi and g.lo==g.hi and p.lo==p.hi:
   r=D(str(float(g.lo)+float(c.lo)+float(f)-float(p.lo)));raw=raw.intersect(Interval(r,r,True,True))
  result={'coverage':c,'gap':g,'freshness':fpart,'penalty':p,'raw_score':raw}
  final=Interval(min(cap,max(D(0),raw.lo)) if raw.lo is not None else 0,min(cap,max(D(0),raw.hi)) if raw.hi is not None else cap,raw.lc,raw.hc)
  result['score_x100']=final.part_x100()
  for k in ('coverage','gap','freshness','penalty'):result['parts_x100.'+k]=result[k].part_x100()
  result.update(nav)
  # Public band constraints have ratios/relative amounts but no absolute cash scale.
  for field in ('cash_match_band','yield_gap_band','collection_rate_band','late_share_band'):
   result[field]=band(field,e[field])
  if 'yield_gap' in e['caps']:result['yield_gap_band']=result['yield_gap_band'].intersect(Interval(3,None))
  if 'collection_shortfall' in e['caps']:result['collection_rate_band']=result['collection_rate_band'].intersect(Interval(0,D('.9'),True,False))
  if 'claimed_not_settled' in e['caps']:result['cash_match_band']=result['cash_match_band'].intersect(Interval(0,D('.98'),True,False))
  # Completed-read coverage and cohort constraints are count constraints, not loan-dollar denominators.
  count=band('loans_checked',e['loans_checked'])
  if count.lo is None:count=Interval(0,10000,True,True)
  possible_c=[];possible_n=[];q=e['pledge_coverage_bps'];step=2500 if e['loans_checked'] in ('lt_5','from_5_to_9','unknown','suppressed') else 100
  for n in range(1,10001):
   low=int(count.lo);high=min(int(count.hi),n)
   if q is not None:
    low=max(low,(q*n+9999)//10000)
    high=min(high,n if q==10000 else (((q+step)*n+9999)//10000)-1)
   if low<=high:possible_c.extend((low,high));possible_n.append(n)
  if not possible_n:raise ValueError('count and coverage constraints conflict')
  result['completed_loan_count']=Interval(min(possible_c),max(possible_c),True,True)
  result['open_loan_count']=Interval(min(possible_n),max(possible_n),True,True)
  cells={}
  for key,value in e['late_loan_cohorts'].items():
   cells[key]=Interval(value,value,True,True) if isinstance(value,int) else Interval(0,0,True,True) if value=='zero' else Interval(1,4,True,True) if value=='lt_5' else Interval(0,max(possible_n),True,True)
  for key,cell in cells.items():
   upper=max(possible_n)-sum(other.lo for k,other in cells.items() if k!=key)
   result['cohort.'+key]=cell.intersect(Interval(0,upper,True,True))
  result['blocked_attempt_count']=band('blocked_attempts',e['blocked_attempts'])
  for exception in e['exceptions']:
   # Omitted codes make no assertion; explicit none/low/material contributes information.
   if exception['code']=='claimed_not_settled':
    if exception['band']=='none':result['cash_match_band']=result['cash_match_band'].intersect(Interval(1,1,True,True))
    elif exception['band']=='low':result['cash_match_band']=result['cash_match_band'].intersect(Interval(D('.98'),1,True,False))
    elif exception['band']=='material':result['cash_match_band']=result['cash_match_band'].intersect(Interval(0,D('.98'),True,False))
  # Scaling settlements, claims and dues together preserves their public bands and cap predicates.
  # USD, source signatures, exception codes and count-only cohorts supply no absolute cash denominator.
  result['cash_amounts']=Interval(0,None)
  result['original_loan_principal']=Interval(0,None) # Original principal can be arbitrarily large with repayments.
  # Current EAD has only a broad valuation-derived ceiling, not a per-loan published figure.
  result['loan_outstanding']=Interval(0,nav['trueval'].hi/D('.33') if nav['trueval'].hi is not None else None)
  return result

def assert_not_narrower(actual,expected):
 for name,b in expected.items():
  a=actual[name];width=a.width()
  if b['policy']=='public_rounding':
   baseline=Interval(b['lower'],b['upper'],b['lower_closed'],b['upper_closed'])
  elif b['policy']=='minimum_width':
   if width is not None and width+EPS<D(b['width']):raise AssertionError('finer disclosure: '+name)
   continue
  else:baseline=Interval(b['lower'],b['upper'],b['lower_closed'],b['upper_closed'])
  if baseline.lo is None and a.lo is not None:raise AssertionError('finer lower bound: '+name)
  if baseline.hi is None and a.hi is not None:raise AssertionError('finer upper bound: '+name)
  if baseline.lo is not None and a.lo is not None and a.lo>baseline.lo+EPS:raise AssertionError('finer lower bound: '+name)
  if baseline.hi is not None and a.hi is not None and a.hi<baseline.hi-EPS:raise AssertionError('finer upper bound: '+name)
  if baseline.lo is not None and a.lo is not None and abs(a.lo-baseline.lo)<EPS and baseline.lc and not a.lc:raise AssertionError('finer open lower endpoint: '+name)
  if baseline.hi is not None and a.hi is not None and abs(a.hi-baseline.hi)<EPS and baseline.hc and not a.hc:raise AssertionError('finer open upper endpoint: '+name)
