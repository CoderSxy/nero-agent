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
    { apiKey: 'test-key', fetchImpl },
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
    auto_parameters: false,
    chunks_per_source: 1,
  });
  assert.deepEqual(result, {
    query: 'Mastra tools',
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
