import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestContext } from '@mastra/core/request-context';
import { financeCatalog, getFinanceInterface, searchFinanceCatalog, validateFinanceParameters } from '../src/mastra/finance/catalog';
import { fetchFinanceData } from '../src/mastra/finance/aktools-client';
import { readFinanceCategory, setVerifiedFinanceCategory, trustedFinanceCategory } from '../src/mastra/finance/scope';

test('finance catalog limits categories and rejects unsafe values', () => {
  assert.equal(financeCatalog.length, 5);
  assert.equal(getFinanceInterface('stock_zh_a_hist', 'fund'), null);
  assert.ok(getFinanceInterface('stock_zh_a_hist', 'all'));
  assert.ok(searchFinanceCatalog('行情', 'a_stock').length <= 5);
  assert.equal(searchFinanceCatalog('股价', 'all')[0]?.name, 'stock_zh_a_hist');
  assert.deepEqual(searchFinanceCatalog('行情', 'macro'), []);
  const stock = getFinanceInterface('stock_zh_a_hist', 'a_stock')!;
  const valid = { symbol: '000001', start_date: '20260101', end_date: '20260131' };
  assert.deepEqual(validateFinanceParameters(stock, valid), valid);
  assert.throws(() => validateFinanceParameters(stock, { ...valid, symbol: '000001";import os' }));
  assert.throws(() => validateFinanceParameters(stock, { ...valid, extra: 'x' }));
  assert.throws(() => validateFinanceParameters(stock, { ...valid, end_date: '20280131' }));
});

test('finance scope ignores a forged request context value', () => {
  const context = new RequestContext();
  context.set('nero-agent.finance-category.trusted', 'a_stock');
  assert.equal(trustedFinanceCategory(context), null);
  assert.equal(readFinanceCategory({ neroAgentFinanceCategory: 'unknown' }), null);
  setVerifiedFinanceCategory(context, readFinanceCategory({ neroAgentFinanceCategory: 'a_stock' }));
  assert.equal(trustedFinanceCategory(context), 'a_stock');
});

test('AKTools client fixes local origin, bounds rows and reports data time separately', async () => {
  const previous = process.env.AKTOOLS_BASE_URL;
  process.env.AKTOOLS_BASE_URL = 'http://127.0.0.1:18080/';
  try {
    const item = getFinanceInterface('macro_china_cpi', 'macro')!;
    const calls: string[] = [];
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify([{ 月份: '2026-01', '全国-同比增长': 1.2 }]),
        { headers: { 'content-type': 'application/json' } });
    };
    const result = await fetchFinanceData(item, {}, fake as typeof fetch);
    assert.equal(calls[0], 'http://127.0.0.1:18080/api/public/macro_china_cpi');
    assert.equal(result.dataTime, '2026-01');
    assert.notEqual(result.fetchedAt, result.dataTime);
    await assert.rejects(fetchFinanceData(item, {}, async () => new Response('<html>error</html>',
      { headers: { 'content-type': 'text/html' } }) as typeof fetch), /不是 JSON/);
    process.env.AKTOOLS_BASE_URL = 'http://example.com:18080/';
    await assert.rejects(fetchFinanceData(item, {}, fake as typeof fetch), /本机 HTTP/);
  } finally {
    if (previous === undefined) delete process.env.AKTOOLS_BASE_URL;
    else process.env.AKTOOLS_BASE_URL = previous;
  }
});
