import assert from 'node:assert/strict';
import test from 'node:test';
import { searchTavily } from '../src/mastra/tools/tavily-search-tool';

test('searchTavily requests Tavily basic search and normalizes results', async () => {
  let request: Request | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Mastra docs',
            url: 'https://mastra.ai/docs',
            content: 'Documentation for Mastra.',
            score: 0.98,
            published_date: '2026-09-01',
          },
        ],
        usage: { credits: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const result = await searchTavily(
    { query: 'Mastra tools', maxResults: 3 },
    { apiKey: 'test-key', fetchImpl, now: () => new Date('2026-10-17T01:00:00Z') },
  );

  assert.equal(request?.url, 'https://api.tavily.com/search');
  assert.equal(request?.headers.get('authorization'), 'Bearer test-key');
  assert.deepEqual(await request?.json(), {
    query: 'Mastra tools',
    search_depth: 'basic',
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
    include_published_date: true,
    filter_by_published_date: false,
    auto_parameters: false,
    chunks_per_source: 1,
  });
  assert.deepEqual(result, {
    query: 'Mastra tools',
    retrievedAt: '2026-10-17T01:00:00.000Z',
    results: [
      {
        title: 'Mastra docs',
        url: 'https://mastra.ai/docs',
        content: 'Documentation for Mastra.',
        score: 0.98,
        publishedDate: '2026-09-01',
      },
    ],
    credits: 1,
  });
});

test('searchTavily reports a missing API key before requesting Tavily', async () => {
  const previous = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    await assert.rejects(
      () => searchTavily({ query: 'Mastra' }, { apiKey: undefined }),
      /TAVILY_API_KEY is required/,
    );
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});

test('searchTavily returns a clear error for a Tavily failure', async () => {
  const fetchImpl: typeof fetch = async () => new Response('rate limited', { status: 429 });

  await assert.rejects(
    () => searchTavily({ query: 'Mastra' }, { apiKey: 'test-key', fetchImpl }),
    /Tavily search failed with status 429/,
  );
});


test('searchTavily maps absolute publication windows and advanced depth', async () => {
  let body: Record<string, unknown> = {};
  const result = await searchTavily({ query: '最新天气来源', startDate: '2026-10-16',
    endDate: '2026-10-17', searchDepth: 'advanced' }, { apiKey: 'test-key',
    now: () => new Date('2026-10-17T01:02:03Z'), fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ results: [{ url: 'https://example.com', title: 'Dynamic weather', content: 'today' }] });
    } });
  assert.equal(body.start_date, '2026-10-16');
  assert.equal(body.end_date, '2026-10-17');
  assert.equal(body.search_depth, 'advanced');
  assert.equal(body.max_results, 5);
  assert.equal(result.results[0].publishedDate, null);
  assert.equal(result.retrievedAt, '2026-10-17T01:02:03.000Z');
});

test('searchTavily maps relative windows without adding absolute dates', async () => {
  let body: Record<string, unknown> = {};
  await searchTavily({ query: '天气', timeRange: 'day' }, { apiKey: 'test-key',
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ results: [] });
    } });
  assert.equal(body.time_range, 'day');
  assert.equal(body.start_date, undefined);
  assert.equal(body.end_date, undefined);
});

test('invalid dates and contradictory windows fail before any HTTP request', async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return Response.json({ results: [] }); };
  for (const filters of [
    { startDate: '2026-02-29' }, { endDate: '2026-2-01' },
    { startDate: '2026-10-18', endDate: '2026-10-17' },
    { timeRange: 'day', startDate: '2026-10-17' },
    { timeRange: 'week', endDate: '2026-10-17' },
    { timeRange: 'invalid' }, { searchDepth: 'invalid' },
  ]) {
    await assert.rejects(() => searchTavily({ query: '天气', ...filters } as never,
      { apiKey: 'test-key', fetchImpl }));
  }
  assert.equal(requests, 0);
});
