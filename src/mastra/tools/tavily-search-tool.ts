import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const tavilySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe('The topic or question to search for.'),
  maxResults: z.number().int().min(1).max(10).default(5).describe('Maximum number of results to return.'),
});

const tavilySearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number().optional(),
      publishedDate: z.string().nullable(),
    }),
  ),
  credits: z.number().optional(),
});

const tavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default('Untitled result'),
        url: z.string(),
        content: z.string().default(''),
        score: z.number().optional(),
        published_date: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z.object({ credits: z.number() }).optional(),
});

type TavilySearchInput = z.infer<typeof tavilySearchInputSchema>;
type TavilySearchOutput = z.infer<typeof tavilySearchOutputSchema>;

type TavilySearchOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
};

export async function searchTavily(
  { query, maxResults = 5 }: TavilySearchInput,
  options: TavilySearchOptions = {},
): Promise<TavilySearchOutput> {
  const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is required to use web search.');
  }

  const response = await (options.fetchImpl ?? fetch)('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      auto_parameters: false,
      chunks_per_source: 1,
    }),
    signal: options.abortSignal,
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed with status ${response.status}.`);
  }

  const payload = tavilyResponseSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new Error('Tavily search returned an invalid response.');
  }

  return {
    query,
    results: payload.data.results.map(result => ({
      title: result.title,
      url: result.url,
      content: result.content,
      score: result.score,
      publishedDate: result.published_date ?? null,
    })),
    credits: payload.data.usage?.credits,
  };
}

export const tavilySearchTool = createTool({
  id: 'web_search',
  description:
    'Search the public web for current information. Use this to discover relevant sources and URLs; use web_fetch to read a specific known URL.',
  inputSchema: tavilySearchInputSchema,
  outputSchema: tavilySearchOutputSchema,
  execute: async (input, { abortSignal }) => searchTavily(input, { abortSignal }),
});
