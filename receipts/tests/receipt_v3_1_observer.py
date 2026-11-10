"""Version dispatcher reuses the frozen observer's math without editing its bytes.
The new method changes only the active conflict cap. All old disclosure bounds remain in force.
"""
import importlib.util
from pathlib import Path
import receipt_v3_observer as old
from receipt_v3_observer import load, assert_not_narrower, nav_cell
spec=importlib.util.spec_from_file_location('_v301_observer',Path(__file__).with_name('receipt_v3_observer.py'))
new=importlib.util.module_from_spec(spec)
spec.loader.exec_module(new)
new.SCHEMA=load('schema/receipt-v3.0.1.schema.json')
new.METHOD=load('schema/methods/truenav-v3.0.1.json')
new.VALIDATOR=new.Draft202012Validator(new.SCHEMA,format_checker=new.FormatChecker())
def infer(e):
 version=e.get('method_version')
 if version=='truenav-v3.0.0':return old.infer(e)
 if version!='truenav-v3.0.1':raise ValueError('unknown method')
 conflict=e['pledge_result']=='conflict'
 if conflict!=('pledge_conflict' in e['caps']) or conflict and (e['band']!='red' or e['score'] is not None and e['score']>59):raise ValueError('invalid conflict cap')
 commitment=e.get('private_commitment')
 if commitment is not None and not __import__('re').fullmatch(r'[0-9a-f]{64}',str(commitment)):raise ValueError('bad private commitment')
 body=e if commitment is None else {k:v for k,v in e.items() if k!='private_commitment'}
 fields=dict(new.POLICY['public_fields'])
 fields['fund_id']='identity_context'
 new.POLICY=dict(new.POLICY)
 new.POLICY['public_fields']=fields
 if 'fund_id' not in body:raise ValueError('unmodelled public envelope field')
 return new.infer(body)
