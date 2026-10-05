import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardedModelFetch, assertPublicAddress } from '../src/mastra/models/transport';

test('model transport rejects redirects and URLs outside its configured base', async () => {
  const calls: Array<{ url: string; redirect: RequestRedirect }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect ?? 'follow' });
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  };
  const guarded = createGuardedModelFetch(new URL('https://models.example.test/v1'), fetchStub);
  await assert.rejects(guarded('https://evil.example.test/v1/chat/completions', {}));
  await assert.rejects(createGuardedModelFetch(new URL('http://127.0.0.1:7864/v1'), fetchStub)(
    'http://127.0.0.1:7864/v1/chat/completions', {},
  ));
  assert.equal(calls.length, 0);
  await assert.rejects(guarded('https://models.example.test/v1/chat/completions', {}), /redirect/i);
  assert.deepEqual(calls, [{ url: 'https://models.example.test/v1/chat/completions', redirect: 'error' }]);
});

test('model transport rejects non-public DNS answers', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '::1', 'fc00::1', '::ffff:127.0.0.1']) {
    assert.throws(() => assertPublicAddress(address), address);
  }
  assert.doesNotThrow(() => assertPublicAddress('101.37.135.116'));
  assert.doesNotThrow(() => assertPublicAddress('2606:4700:4700::1111'));
});
