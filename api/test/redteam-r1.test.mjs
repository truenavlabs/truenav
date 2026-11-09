// Red team round 1. The public score route must not repeat exact v2 money or score parts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from '../server.mjs';

test('redteam_r1 public v2 score must not expose exact cents or parts', async () => {
  const fx = JSON.parse(readFileSync(new URL('../../receipts/tests/fixtures/engine-receipts.json', import.meta.url))).receipts;
  const output = JSON.parse(fx['HONEST-CREDIT'].output);
  const record = {
    token_id: 'HONEST-CREDIT',
    seq: 1,
    method: output.method,
    version_key: 'ab'.repeat(32),
    score: output.score,
    band: output.band,
    period: output.period,
    as_of: output.as_of,
    caps: output.caps.map((c) => c.code),
    holds: output.holds.map((h) => h.code),
    receipt_sha256: 'ab'.repeat(32),
    receipt: fx['HONEST-CREDIT'].output,
    block_height: 1,
  };
  const server = createServer({
    chain: {async view() { return record; }, async nowNs() { return 0n; }, async redeem() { return 0; }},
    receipts: 'receipts.test',
    query: 'query.test',
    fee: '1',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/fund/HONEST-CREDIT/score`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.uncapped_score, undefined);
    assert.equal(body.collection?.rate_bps, undefined);
    const text = JSON.stringify(body);
    assert.equal(text.includes('7857'), false);
    assert.equal(text.includes('parts_x100'), false);
    assert.equal(text.includes('cash_received_cents'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
