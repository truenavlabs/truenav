// Public receipt compatibility only. Never infer private values from public bands.
export const TOKEN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
export const validToken = token => typeof token === 'string' && token.length <= 64 && TOKEN.exec(token)?.[0] === token;
const failure = code => { throw Object.assign(new Error(code), {code}); };
export function decodeReceipt(record) {
  if (record?.error) failure(record.error === 'v3_receipt_corrupt' ? record.error : 'receipt_invalid');
  let receipt;
  try { receipt = typeof record?.receipt === 'string' ? JSON.parse(record.receipt) : record; }
  catch { failure(record?.method?.startsWith('truenav-v3.') ? 'v3_receipt_corrupt' : 'receipt_invalid'); }
  if (!receipt || !['2','3',undefined].includes(receipt.receipt_version)) failure('receipt_version_unsupported');
  if (receipt.receipt_version === '2' || (receipt.receipt_version === undefined && record.method?.startsWith('cashflow-v2.'))) {
    if (record.receipt_version && record.receipt_version !== '2') failure('receipt_version_mismatch');
    return {record, receipt, version:'2'};
  }
  if (record.receipt_version && record.receipt_version !== '3') failure('receipt_version_mismatch');
  if (!['truenav-v3.0.0','truenav-v3.0.1'].includes(receipt.method_version) || !Array.isArray(receipt.caps) || !Array.isArray(receipt.holds)) failure('v3_receipt_corrupt');
  const normalized = typeof record.receipt === 'string' ? record : {
    token_id:receipt.token_id, seq:receipt.seq, score:receipt.score, band:receipt.band,
    caps:receipt.caps, holds:receipt.holds, period:`${receipt.period_start}/${receipt.period_end}`,
    as_of:receipt.valuation_time, method:receipt.method_version, version_key:receipt.engine_version_key,
    receipt_sha256:receipt.receipt_sha256, block_height:null, receipt:JSON.stringify(receipt),
  };
  return {record:normalized, receipt, version:'3'};
}
export function publicV3(receipt) {
  const fields=['receipt_version','token_id','seq','method_version','engine_version_key','period_start','period_end','data_as_of','valuation_time','score','band','parts_band','caps','holds','freshness_band','currency','reported_nav','trueval','truerange_low','truerange_high','nav_result','nav_gap_band','unverified_share_band','pledge_scope','pledge_result','pledge_coverage_bps','loans_checked','blocked_attempts','cash_evidence_status','cash_match_band','yield_gap_band','collection_rate_band','late_share_band','late_loan_cohorts','exceptions','synthetic','receipt_sha256'];
  return Object.fromEntries(fields.filter(k=>Object.hasOwn(receipt,k)).map(k=>[k,receipt[k]]));
}
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
