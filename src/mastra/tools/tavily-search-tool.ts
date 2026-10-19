import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isCalendarDate } from '../temporal/date-range';

const calendarDate = z.string().refine(isCalendarDate, '必须是合法的 YYYY-MM-DD 日历日期');

export const tavilySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe('要搜索的主题或问题。'),
  maxResults: z.number().int().min(1).max(10).default(5).describe('最多返回的结果数量。'),
  timeRange: z.enum(['day', 'week', 'month', 'year']).optional()
    .describe('按来源发布或更新时间过滤最近一天/周/月/年；不是预报有效期，不与 startDate/endDate 同用。'),
  startDate: calendarDate.optional().describe('来源发布或更新时间的起始过滤日期，不是天气预报起始日。'),
  endDate: calendarDate.optional().describe('来源发布或更新时间的结束过滤日期，不是天气预报结束日。'),
  searchDepth: z.enum(['basic', 'advanced']).optional().describe('默认 basic；需更深入检索时才选 advanced。'),
}).superRefine((input, ctx) => {
  if (input.timeRange && (input.startDate || input.endDate)) {
    ctx.addIssue({ code: 'custom', path: ['timeRange'], message: '相对时间过滤不能与绝对日期过滤同时使用' });
  }
  if (input.startDate && input.endDate && input.startDate > input.endDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: '结束日期不能早于起始日期' });
  }
});

const tavilySearchOutputSchema = z.object({
  query: z.string(),
  retrievedAt: z.string().describe('服务端实际获取结果的 UTC 时间，不代表来源更新时间或预报有效期。'),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      score: z.number().optional(),
      publishedDate: z.string().nullable().describe('Tavily 估计的来源发布或更新时间，未知为 null；不是预报有效期。'),
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

type TavilySearchInput = z.input<typeof tavilySearchInputSchema>;
type TavilySearchOutput = z.infer<typeof tavilySearchOutputSchema>;

type TavilySearchOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
  now?: () => Date;
};

export async function searchTavily(
  input: TavilySearchInput,
  options: TavilySearchOptions = {},
): Promise<TavilySearchOutput> {
  const { query, maxResults, timeRange, startDate, endDate, searchDepth } = tavilySearchInputSchema.parse(input);
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
      search_depth: searchDepth ?? 'basic',
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      include_published_date: true,
      filter_by_published_date: false,
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
    retrievedAt: (options.now?.() ?? new Date()).toISOString(),
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
    '搜索公开网络中的最新信息，用于发现相关来源和网址；已知具体网址时使用 web_fetch 阅读。时间过滤针对来源发布或更新时间，不保证预报覆盖日期；天气需核对正文日期，不能将未来预报范围直接作为发布时间过滤。',
  inputSchema: tavilySearchInputSchema,
  outputSchema: tavilySearchOutputSchema,
  execute: async (input, { abortSignal }) => searchTavily(input, { abortSignal }),
});
